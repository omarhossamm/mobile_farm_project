#!/usr/bin/env node
/**
 * One-command bootstrap for the extension.
 *
 * Runs on `npm install`. Does the following, in order:
 *
 *  1. Publishes the sibling `EmulatorDesktopApp/` (Avalonia .NET) for
 *     the current platform via `dotnet publish` and copies the result
 *     into `vendor/desktop-app/`. That binary is what the extension
 *     spawns to display the live stream — see src/streamProcess.ts.
 *
 *  2. Compiles the extension itself (tsc).
 *
 *  3. Symlinks this directory into every detected VS Code / Cursor
 *     extensions folder (~/.vscode/extensions, ~/.vscode-insiders/…,
 *     ~/.cursor/extensions, ~/.vscode-oss/…). The editor picks it up
 *     on its next launch — no `.vsix` packaging or manual install.
 *
 * All steps are idempotent — safe to re-run after edits.
 *
 * Set `EMULATOR_STREAM_SKIP_BOOTSTRAP=1` to disable (useful in CI or
 * when installing this package as a nested dependency).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

if (process.env.EMULATOR_STREAM_SKIP_BOOTSTRAP === '1') {
  process.stdout.write('bootstrap: skipped via EMULATOR_STREAM_SKIP_BOOTSTRAP=1\n');
  process.exit(0);
}

const extensionRoot = path.resolve(__dirname, '..');
const siblingDesktopApp = path.resolve(extensionRoot, '..', 'EmulatorDesktopApp');
const vendorRoot = path.join(extensionRoot, 'vendor', 'desktop-app');
const targetFramework = readTargetFramework(siblingDesktopApp);

// Bump this every time we change how the extension talks to the desktop app
// (new CLI flag, new WS protocol event, new headless behaviour, etc.). The
// extension asserts the running binary was built with the SAME contract by
// reading vendor/desktop-app/BUILD_INFO.json → features. See
// src/desktopAppFreshness.ts on the extension side.
const REQUIRED_DESKTOP_APP_FEATURES = ['headless-attach-v1'];

step(`Publish EmulatorDesktopApp for this platform (${targetFramework ?? '?'})`, () => {
  if (!fs.existsSync(siblingDesktopApp)) {
    fatal(
      `Cannot find ../EmulatorDesktopApp at ${siblingDesktopApp}. ` +
      `This extension expects that project as a sibling folder.`
    );
  }
  if (!targetFramework) {
    fatal('Could not read <TargetFramework> from EmulatorDesktopApp.csproj');
  }
  // Match production packaging: flat vendor/desktop-app/ with only this
  // platform's publish output (EmulatorDesktopApp[.exe], native libs, …).
  const rid = detectDotnetRid();
  log(`publishing for ${rid}…`);
  execFileSync(
    'dotnet',
    ['publish', '-c', 'Release', '-r', rid, '--self-contained', 'false', '-p:UseAppHost=true'],
    { cwd: siblingDesktopApp, stdio: 'inherit' }
  );
  const publishDir = path.join(siblingDesktopApp, 'bin', 'Release', targetFramework, rid, 'publish');
  if (!fs.existsSync(publishDir)) {
    fatal(`publish output missing at ${publishDir}`);
  }
  if (rid === 'win-x64' || rid === 'win-arm64') {
    const { ensureWinFfmpegInPublishDir, hasWinFfmpeg } = require('./ensure-win-ffmpeg');
    ensureWinFfmpegInPublishDir(publishDir);
    if (!hasWinFfmpeg(publishDir)) {
      fatal(`Windows FFmpeg DLLs missing in ${publishDir}/ffmpeg/win-x64`);
    }
  }
  const { prunePublishDir } = require('./prune-publish');
  prunePublishDir(publishDir, rid);
  fs.rmSync(vendorRoot, { recursive: true, force: true });
  fs.mkdirSync(vendorRoot, { recursive: true });
  copyRecursive(publishDir, vendorRoot);
  writeBuildInfo(vendorRoot, rid);
  log(`bundled desktop app → ${vendorRoot}`);
});

step('Compile extension', () => {
  const tsc = path.join(extensionRoot, 'node_modules', '.bin', 'tsc');
  const tscBin = process.platform === 'win32' ? `${tsc}.cmd` : tsc;
  if (!fs.existsSync(tscBin)) {
    log('tsc not yet present (extension node_modules still installing); skipping — a follow-up compile will run on next launch');
    return;
  }
  execFileSync(tscBin, ['-p', path.join(extensionRoot, 'tsconfig.json')], {
    cwd: extensionRoot, stdio: 'inherit',
  });
});

step('Self-install into VS Code / Cursor extensions folder(s)', () => {
  const targets = discoverExtensionsFolders();
  if (targets.length === 0) {
    log('no VS Code / Cursor extensions folder found — skipping symlink');
    return;
  }
  const linkName = 'local.emulator-stream-run-0.1.0';
  for (const dir of targets) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    const target = path.join(dir, linkName);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || stat.isFile()) fs.unlinkSync(target);
      else if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    } catch { /* not there yet */ }
    try {
      fs.symlinkSync(extensionRoot, target, 'dir');
      log(`installed → ${target}`);
    } catch (err) {
      log(`skipped ${target}: ${err && err.message ? err.message : err}`);
    }
  }
});

process.stdout.write('\nbootstrap: done. Open a Flutter project in VS Code (or Cursor) and press F5.\n');

// ── helpers ─────────────────────────────────────────────────────────────

function step(label, body) {
  process.stdout.write(`\n▸ ${label}\n`);
  try {
    body();
  } catch (err) {
    fatal(`step failed: ${label}: ${err && err.stack ? err.stack : err}`);
  }
}

function log(msg) { process.stdout.write(`  ${msg}\n`); }

function fatal(msg) {
  process.stderr.write(`\n✖ ${msg}\n`);
  process.exit(1);
}

function copyRecursive(src, dest) {
  const stat = fs.lstatSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dest);
    return;
  }
  fs.copyFileSync(src, dest);
}

function detectDotnetRid() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin') return arch === 'arm64' ? 'osx-arm64' : 'osx-x64';
  if (platform === 'linux')  return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  if (platform === 'win32')  return arch === 'arm64' ? 'win-arm64'  : 'win-x64';
  throw new Error(`unsupported platform: ${platform}/${arch}`);
}

/**
 * Read the <TargetFramework> from the .csproj so we don't hardcode
 * `net10.0` and silently break on upgrades.
 */
/**
 * Emit a BUILD_INFO.json next to the desktop-app binary. This is how the
 * extension knows the bundle was rebuilt after a code change: at spawn time
 * it reads this file and asserts every entry in
 * `REQUIRED_DESKTOP_APP_FEATURES` is listed under `features`. Missing file
 * or missing feature ⇒ stale bundle warning + one-click rebuild prompt.
 */
function writeBuildInfo(dir, rid) {
  let gitSha = null;
  try {
    gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: extensionRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { /* not a git repo or git missing — that's fine, still emit the file */ }
  const info = {
    builtAt: new Date().toISOString(),
    rid,
    gitSha,
    features: REQUIRED_DESKTOP_APP_FEATURES.slice(),
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
  };
  fs.writeFileSync(path.join(dir, 'BUILD_INFO.json'), JSON.stringify(info, null, 2) + '\n');
}

/**
 * Emit vendor/desktop-app/SUPPORTED_RIDS.json — the top-level
 * manifest the extension consults to know which platforms this
 * install ships binaries for. In dev mode we only ship the current
 * host's RID; the production `scripts/package.js` writes a fatter
 * manifest with every RID it built.
 */
function writeSupportedRidsManifest(builds) {
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    rids: builds.map((b) => ({
      rid: b.rid,
      features: b.features,
    })),
  };
  fs.writeFileSync(
    path.join(vendorRoot, 'SUPPORTED_RIDS.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
}

function readTargetFramework(desktopAppDir) {
  const csproj = path.join(desktopAppDir, 'EmulatorDesktopApp.csproj');
  try {
    const xml = fs.readFileSync(csproj, 'utf8');
    const m = xml.match(/<TargetFramework>([^<]+)<\/TargetFramework>/);
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

function discoverExtensionsFolders() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.vscode-oss', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.cursor-server', 'extensions'),
  ];
  return candidates.filter((p) => {
    // Include even if the folder doesn't exist yet — the target editor
    // may just not be installed here. We only skip parents that clearly
    // don't exist, so we don't spam symlinks in random places.
    const parent = path.dirname(p);
    return fs.existsSync(parent);
  });
}
