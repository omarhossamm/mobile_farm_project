#!/usr/bin/env node
/**
 * Package the VS Code extension into ONE .vsix per target platform.
 *
 * Each .vsix contains ONLY the desktop-app binary + native
 * dependencies for its own platform. There is no download step at
 * runtime, no bundled multi-platform layout, no fallback binaries for
 * other operating systems. The result is a modest per-platform .vsix
 * (~20–60 MB) that installs and runs fully offline on the target
 * machine.
 *
 * Usage:
 *
 *     # One platform (defaults to the current host):
 *     node scripts/package.js
 *
 *     # Specific target(s):
 *     node scripts/package.js --target win32-x64
 *     node scripts/package.js --target darwin-arm64,darwin-x64
 *
 *     # All supported targets in one invocation:
 *     node scripts/package.js --all
 *
 * Supported target ids (vsce naming, matches VS Code marketplace):
 *
 *     win32-x64        (RID: win-x64)
 *     win32-arm64      (RID: win-arm64)
 *     darwin-x64       (RID: osx-x64)
 *     darwin-arm64     (RID: osx-arm64)
 *     linux-x64        (RID: linux-x64)
 *     linux-arm64      (RID: linux-arm64)
 *
 * Output naming follows vsce convention:
 *
 *     dist/emulator-stream-run-<version>-<target>.vsix
 *
 * VS Code / Cursor only allow installing a target-specific .vsix on a
 * host whose OS + arch matches — so shipping the wrong file to a
 * developer produces a clear "unsupported platform" error at install
 * time instead of a confusing missing-binary error at F5 time.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensureWinFfmpegInPublishDir, hasWinFfmpeg } = require('./ensure-win-ffmpeg');

const extensionRoot = path.resolve(__dirname, '..');
const distDir = path.join(extensionRoot, 'dist');
const vendorRoot = path.join(extensionRoot, 'vendor', 'desktop-app');
const siblingDesktopApp = path.resolve(extensionRoot, '..', 'EmulatorDesktopApp');

/** vsce target id → .NET RID. Full universe of what we support. */
const TARGETS = {
  'win32-x64':    'win-x64',
  'win32-arm64':  'win-arm64',
  'darwin-x64':   'osx-x64',
  'darwin-arm64': 'osx-arm64',
  'linux-x64':    'linux-x64',
  'linux-arm64':  'linux-arm64',
};

const REQUIRED_DESKTOP_APP_FEATURES = ['headless-attach-v1'];

const targetsRequested = parseTargets(process.argv.slice(2));
if (targetsRequested.length === 0) {
  fatal('No targets to build. Pass --target <id> or --all.');
}
for (const t of targetsRequested) {
  if (!(t in TARGETS)) {
    fatal(`Unknown target "${t}". Supported: ${Object.keys(TARGETS).join(', ')}`);
  }
}

fs.mkdirSync(distDir, { recursive: true });

// Compile ONCE at the top so every target reuses the same JS output.
step('Compile TypeScript', () => {
  fs.rmSync(path.join(extensionRoot, 'out'), { recursive: true, force: true });
  const tscBin = path.join(extensionRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  execFileSync(tscBin, ['-p', path.join(extensionRoot, 'tsconfig.json')], {
    cwd: extensionRoot, stdio: 'inherit',
  });
});

const results = [];
for (const target of targetsRequested) {
  const rid = TARGETS[target];
  step(`Package ${target}  (rid=${rid})`, () => {
    // Wipe vendor between each target so a stale binary from the
    // previous iteration can never leak into the next .vsix. Each
    // .vsix is exactly one platform.
    fs.rmSync(vendorRoot, { recursive: true, force: true });
    fs.mkdirSync(vendorRoot, { recursive: true });

    const ridDir = path.join(vendorRoot, rid);
    publishDesktopAppForRid(rid, ridDir);
    writeBuildInfo(ridDir, rid);
    writeSupportedRidsManifest([{ rid, features: REQUIRED_DESKTOP_APP_FEATURES.slice() }]);

    const outFile = vsceOutName(target);
    try { fs.unlinkSync(outFile); } catch { /* not present */ }
    runVsce(target, outFile);
    const sizeMB = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(1);
    results.push({ target, rid, outFile, sizeMB });
    log(`→ ${path.relative(extensionRoot, outFile)}  (${sizeMB} MB)`);
  });
}

process.stdout.write(`\n✓ done. Artefacts:\n`);
for (const r of results) {
  process.stdout.write(`   • ${r.target}  ${r.sizeMB} MB  →  ${path.relative(process.cwd(), r.outFile)}\n`);
}

// ── steps ───────────────────────────────────────────────────────────────

function publishDesktopAppForRid(rid, ridDir) {
  if (!fs.existsSync(siblingDesktopApp)) {
    fatal(
      `Cannot find ../EmulatorDesktopApp at ${siblingDesktopApp}. This packaging ` +
      `script only works from a source checkout with the extension and the .NET ` +
      `project side-by-side.`
    );
  }
  log(`dotnet publish -c Release -r ${rid}`);
  execFileSync(
    'dotnet',
    ['publish', '-c', 'Release', '-r', rid, '--self-contained', 'false', '-p:UseAppHost=true'],
    { cwd: siblingDesktopApp, stdio: 'inherit' }
  );
  const targetFramework = readTargetFramework(siblingDesktopApp);
  const publishDir = path.join(siblingDesktopApp, 'bin', 'Release', targetFramework, rid, 'publish');
  if (!fs.existsSync(publishDir)) fatal(`publish output missing at ${publishDir}`);

  // Cross-compilation belt-and-suspenders: FFmpeg.Windows.targets normally
  // pulls the Gyan FFmpeg DLLs during dotnet publish, but if that MSBuild
  // step is skipped (network hiccup, offline mode, older SDK) we fill in
  // the gap here so the win-* .vsix ships with a working FFmpeg.
  if (rid === 'win-x64' || rid === 'win-arm64') {
    ensureWinFfmpegInPublishDir(publishDir);
    if (!hasWinFfmpeg(publishDir)) {
      fatal(`Windows FFmpeg DLLs missing in ${publishDir}/ffmpeg/win-x64 after publish`);
    }
  }

  fs.rmSync(ridDir, { recursive: true, force: true });
  fs.mkdirSync(ridDir, { recursive: true });
  copyRecursive(publishDir, ridDir);
  log(`copied ${publishDir} → ${ridDir}`);
}

function writeBuildInfo(dir, rid) {
  let gitSha = null;
  try {
    gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: extensionRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { /* not a repo */ }
  const info = {
    builtAt: new Date().toISOString(),
    rid,
    gitSha,
    features: REQUIRED_DESKTOP_APP_FEATURES.slice(),
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    packagedBy: 'scripts/package.js',
  };
  fs.writeFileSync(path.join(dir, 'BUILD_INFO.json'), JSON.stringify(info, null, 2) + '\n');
  log(`wrote BUILD_INFO.json (${gitSha ?? 'no-git'} for ${rid})`);
}

function writeSupportedRidsManifest(builds) {
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    rids: builds.map((b) => ({ rid: b.rid, features: b.features })),
  };
  fs.writeFileSync(
    path.join(vendorRoot, 'SUPPORTED_RIDS.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
}

function vsceOutName(target) {
  const version = readVersion();
  return path.join(distDir, `emulator-stream-run-${version}-${target}.vsix`);
}

function runVsce(target, outFile) {
  const vsceBin = path.join(extensionRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');
  execFileSync(
    vsceBin,
    ['package', '--target', target, '--out', outFile, '--allow-star-activation'],
    { cwd: extensionRoot, stdio: 'inherit' }
  );
}

// ── helpers ─────────────────────────────────────────────────────────────

function parseTargets(argv) {
  if (argv.includes('--all')) return Object.keys(TARGETS);

  const collected = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target') {
      const val = argv[i + 1];
      if (!val) fatal(`--target requires a value`);
      val.split(',').map((s) => s.trim()).filter(Boolean).forEach((t) => collected.add(t));
      i++;
    } else if (arg.startsWith('--target=')) {
      arg.slice('--target='.length).split(',').map((s) => s.trim()).filter(Boolean).forEach((t) => collected.add(t));
    }
  }

  if (collected.size === 0) collected.add(currentTarget());
  return Array.from(collected);
}

function currentTarget() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'linux')  return arch === 'arm64' ? 'linux-arm64'  : 'linux-x64';
  if (platform === 'win32')  return arch === 'arm64' ? 'win32-arm64'  : 'win32-x64';
  fatal(`unsupported host platform: ${platform}/${arch}`);
}

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
  return pkg.version;
}

function readTargetFramework(desktopAppDir) {
  const csproj = path.join(desktopAppDir, 'EmulatorDesktopApp.csproj');
  const xml = fs.readFileSync(csproj, 'utf8');
  const m = xml.match(/<TargetFramework>([^<]+)<\/TargetFramework>/);
  if (!m) fatal('Could not read <TargetFramework> from EmulatorDesktopApp.csproj');
  return m[1].trim();
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
  if (stat.mode & 0o100) {
    try { fs.chmodSync(dest, stat.mode); } catch { /* best-effort */ }
  }
}

function step(label, body) {
  process.stdout.write(`\n▸ ${label}\n`);
  try { body(); }
  catch (err) { fatal(`step failed: ${label}: ${err && err.stack ? err.stack : err}`); }
}

function log(msg) { process.stdout.write(`  ${msg}\n`); }

function fatal(msg) {
  process.stderr.write(`\n✖ ${msg}\n`);
  process.exit(1);
}
