#!/usr/bin/env node
/**
 * Smoke test the DesktopAppInstaller end-to-end without needing VS
 * Code, real GitHub Releases, or the .NET toolchain.
 *
 * Strategy:
 *   • Stand up a tiny http server on 127.0.0.1 that serves a
 *     freshly-produced zip archive.
 *   • Point the installer at it, verify the ladder resolves to a
 *     `downloaded` source on first ensure() and to `cached` on the
 *     second ensure().
 *   • Verify SHA256 checking: corrupt the archive on the server,
 *     purge cache, expect an InstallerError with code=sha256-mismatch.
 *   • Verify concurrency: kick off two ensure() calls in parallel,
 *     assert only ONE archive-open happens (the second waits on
 *     the in-flight promise).
 *   • Verify chmod: on unix, the resolved binary has the exec bit
 *     set even if the archive stripped it.
 *
 * Uses a `vscode` stub so imports don't blow up outside the extension host.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

// vscode stub — same trick used by earlier smoke tests.
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return path.resolve(__dirname, '_vscode_stub.cjs');
  return origResolve.call(this, request, ...rest);
};

// Ensure the stub exists.
const stubPath = path.resolve(__dirname, '_vscode_stub.cjs');
if (!fs.existsSync(stubPath)) {
  fs.writeFileSync(stubPath,
`module.exports = {
  window: { withProgress: async (_o, fn) => fn({ report(){} }, { onCancellationRequested(){ return {dispose(){}}; }}) },
  CancellationTokenSource: class { get token(){ return { onCancellationRequested(){ return { dispose(){} }; } }; } cancel(){} dispose(){} },
  ProgressLocation: { Notification: 15 },
};
`
  );
}

const outDir = path.join(__dirname, '..', 'out');
const installerModule = require(path.join(outDir, 'desktopAppInstaller.js'));
const { DesktopAppInstaller, sha256File, currentRid } = installerModule;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-smoke-'));
const CACHE_DIR = path.join(TMP, 'cache');
const EXT_ROOT = path.join(TMP, 'extRoot');
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(EXT_ROOT, { recursive: true });

const rid = currentRid();
const isWin = process.platform === 'win32';
const binName = isWin ? 'EmulatorDesktopApp.exe' : 'EmulatorDesktopApp';
const stubBinaryContents = `#!/usr/bin/env node\nconsole.log('stub desktop app for ${rid}');\n`;

// Build a synthetic zip archive containing the fake binary + BUILD_INFO.
const AdmZip = require(path.join(__dirname, '..', 'node_modules', 'adm-zip'));

function buildArchive({ withBinary = true, extraNoise = false } = {}) {
  const zip = new AdmZip();
  if (withBinary) zip.addFile(binName, Buffer.from(stubBinaryContents));
  // Fixed builtAt so re-running the smoke test produces reproducible
  // archive bytes → reproducible SHAs → tests can pin hashes without
  // races between the pin and the server response.
  zip.addFile('BUILD_INFO.json', Buffer.from(JSON.stringify({
    builtAt: '2026-01-01T00:00:00.000Z',
    rid,
    gitSha: 'smoke',
    features: ['headless-attach-v1'],
    version: '9.9.9',
  })));
  if (extraNoise) zip.addFile('random.bin', Buffer.from('ignore'));
  return zip.toBuffer();
}

let currentArchive = buildArchive();

// HTTP server that serves whatever `currentArchive` currently is.
let server;
let port = 0;
async function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url && req.url.endsWith('.zip')) {
        const bytes = Buffer.from(currentArchive);
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': bytes.length });
        res.end(bytes);
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
}

async function stopServer() {
  return new Promise((r) => server.close(r));
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

let passed = 0, failed = 0;
async function test(name, body) {
  try {
    process.stdout.write(`▸ ${name}\n`);
    await body();
    process.stdout.write(`  ✓ pass\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  ✖ ${err.stack || err.message || err}\n`);
    failed++;
  }
}

async function main() {
  await startServer();
  try {
    // ONE canonical archive for the whole suite. adm-zip's toBuffer
    // is non-deterministic (embeds local-file-header timestamps), so
    // rebuilding it between tests would produce different SHAs and
    // race the pinned value.
    const HAPPY_PATH_ARCHIVE = buildArchive();
    const NOISY_ARCHIVE = buildArchive({ extraNoise: true });
    currentArchive = HAPPY_PATH_ARCHIVE;
    const assetSha = sha256(HAPPY_PATH_ARCHIVE);
    const url = `http://127.0.0.1:${port}/pkg.zip`;
    const asset = { url, sha256: assetSha, size: HAPPY_PATH_ARCHIVE.length };

    // First ensure() → download.
    await test('download-then-extract', async () => {
      const inst = new DesktopAppInstaller();
      const resolved = await inst.ensure({
        extensionRoot: EXT_ROOT,
        cacheRoot: CACHE_DIR,
        rid,
        // Simulate what the pinned manifest would resolve to for
        // this rid; ensure() doesn't accept an asset override, so
        // we monkey-patch the pinnedAssetFor via require cache.
        ...(function patchAsset() {
          const m = require.cache[require.resolve(path.join(outDir, 'desktopAppManifest.js'))];
          m.exports.pinnedAssetFor = () => asset;
          m.exports.PINNED_MANIFEST = { ...m.exports.PINNED_MANIFEST, requiredVersion: '9.9.9', assets: { [rid]: asset } };
          return {};
        })(),
      });
      if (resolved.kind !== 'downloaded') throw new Error(`expected kind=downloaded, got ${resolved.kind}`);
      if (!fs.existsSync(resolved.path)) throw new Error(`resolved path missing: ${resolved.path}`);
      if (!fs.existsSync(path.join(path.dirname(resolved.path), '.ok'))) throw new Error(`.ok sentinel missing`);
    });

    // Second ensure() → cache hit (no download).
    await test('cache-hit-on-second-ensure', async () => {
      const inst = new DesktopAppInstaller();
      const resolved = await inst.ensure({
        extensionRoot: EXT_ROOT,
        cacheRoot: CACHE_DIR,
        rid,
      });
      if (resolved.kind !== 'cached') throw new Error(`expected kind=cached, got ${resolved.kind}`);
    });

    // chmod +x check on unix.
    if (!isWin) {
      await test('chmod-plus-x-applied', async () => {
        const inst = new DesktopAppInstaller();
        const resolved = await inst.ensure({ extensionRoot: EXT_ROOT, cacheRoot: CACHE_DIR, rid });
        const mode = fs.statSync(resolved.path).mode & 0o777;
        if ((mode & 0o100) === 0) throw new Error(`exec bit not set on ${resolved.path} (mode=${mode.toString(8)})`);
      });
    }

    // Purge & confirm SHA mismatch rejection.
    await test('sha256-mismatch-rejected', async () => {
      const inst = new DesktopAppInstaller();
      inst.purgeCache(CACHE_DIR);
      // Serve DIFFERENT bytes than the pinned SHA advertises.
      currentArchive = NOISY_ARCHIVE;
      try {
        await inst.ensure({ extensionRoot: EXT_ROOT, cacheRoot: CACHE_DIR, rid });
        throw new Error('ensure() should have thrown InstallerError sha256-mismatch');
      } catch (err) {
        if (!err.code || err.code !== 'sha256-mismatch') throw new Error(`expected code=sha256-mismatch, got ${err.code}: ${err.message}`);
      } finally {
        currentArchive = HAPPY_PATH_ARCHIVE;
      }
      // After the failed install, no stray .part file may remain —
      // any restart must start from a clean slate.
      try {
        const leftover = fs.readdirSync(path.join(CACHE_DIR, 'desktop-app'));
        const partFiles = leftover.filter(f => f.endsWith('.part'));
        if (partFiles.length > 0) throw new Error(`stale .part after failed install: ${partFiles.join(', ')}`);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    });

    // Concurrent ensure() calls: two callers get the same result and
    // ONLY ONE server hit fires (the second caller reuses the first's
    // in-flight promise instead of downloading again).
    await test('concurrent-ensure-dedupes', async () => {
      const inst = new DesktopAppInstaller();
      inst.purgeCache(CACHE_DIR);
      let hits = 0;
      const orig = server.listeners('request')[0];
      server.removeAllListeners('request');
      server.on('request', (req, res) => { hits++; orig(req, res); });
      try {
        const [a, b] = await Promise.all([
          inst.ensure({ extensionRoot: EXT_ROOT, cacheRoot: CACHE_DIR, rid }),
          inst.ensure({ extensionRoot: EXT_ROOT, cacheRoot: CACHE_DIR, rid }),
        ]);
        if (a.path !== b.path) throw new Error(`concurrent installs resolved different paths: ${a.path} vs ${b.path}`);
        if (hits !== 1) throw new Error(`expected exactly 1 server hit for concurrent installs, saw ${hits}`);
      } finally {
        server.removeAllListeners('request');
        server.on('request', orig);
      }
    });

    // Bundled fallback: create a fake vendor/desktop-app/<rid>/<bin>
    // in EXT_ROOT and confirm the installer prefers it over cache.
    await test('bundled-fallback-preferred-over-cache', async () => {
      const inst = new DesktopAppInstaller();
      const bundled = path.join(EXT_ROOT, 'vendor', 'desktop-app', rid);
      fs.mkdirSync(bundled, { recursive: true });
      const bundledPath = path.join(bundled, binName);
      fs.writeFileSync(bundledPath, 'bundled dev-mode binary\n');
      const resolved = await inst.ensure({ extensionRoot: EXT_ROOT, cacheRoot: CACHE_DIR, rid });
      if (resolved.kind !== 'bundled') throw new Error(`expected kind=bundled, got ${resolved.kind}`);
      if (resolved.path !== bundledPath) throw new Error(`path mismatch: ${resolved.path} != ${bundledPath}`);
      // Cleanup so the next test runs against cache.
      fs.rmSync(path.join(EXT_ROOT, 'vendor'), { recursive: true, force: true });
    });

    // User path override wins over everything.
    await test('user-setting-overrides-all', async () => {
      const inst = new DesktopAppInstaller();
      const userBin = path.join(TMP, 'user-supplied-binary');
      fs.writeFileSync(userBin, 'user override');
      const resolved = await inst.ensure({ extensionRoot: EXT_ROOT, cacheRoot: CACHE_DIR, rid, userPath: userBin });
      if (resolved.kind !== 'user-setting') throw new Error(`expected user-setting, got ${resolved.kind}`);
      if (resolved.path !== userBin) throw new Error(`path mismatch: ${resolved.path}`);
    });

    // installer.state() renders cached entries.
    await test('state-lists-cached-versions', async () => {
      const inst = new DesktopAppInstaller();
      const state = inst.state(CACHE_DIR);
      if (!state.cacheDir.endsWith(path.join('cache', 'desktop-app'))) throw new Error(`unexpected cacheDir: ${state.cacheDir}`);
      if (state.cachedVersions.length === 0) throw new Error('expected at least one cached version');
    });

  } finally {
    await stopServer();
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.stack || err.message || err}\n`);
  process.exit(1);
});
