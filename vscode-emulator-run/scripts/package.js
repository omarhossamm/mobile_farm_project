#!/usr/bin/env node
/**
 * Package the VS Code extension into one **platform-specific** `.vsix`.
 *
 * Each VSIX is fully offline and self-contained: it ships exactly one
 * `dotnet publish` output (plus Windows FFmpeg DLLs when applicable).
 * No other platform's binaries are included.
 *
 * Usage:
 *
 *     node scripts/package.js                        # host platform
 *     node scripts/package.js --target win32-x64
 *     node scripts/package.js --target darwin-arm64
 *     node scripts/package.js --all                  # every supported target
 *     node scripts/package.js --universal            # one vsix: Windows + Mac
 *
 * Output (one file per invocation):
 *
 *     dist/emulator-stream-run-<version>-<target>.vsix   (single-platform)
 *     dist/emulator-stream-run-<version>.vsix            (--universal)
 *
 * Examples:
 *     dist/emulator-stream-run-0.2.0-win32-x64.vsix
 *     dist/emulator-stream-run-0.2.0-darwin-arm64.vsix
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensureWinFfmpegInPublishDir, hasWinFfmpeg } = require('./ensure-win-ffmpeg');
const { prunePublishDir } = require('./prune-publish');
const { renderReport, formatBytes } = require('./size-report');

const extensionRoot = path.resolve(__dirname, '..');
const distDir = path.join(extensionRoot, 'dist');
const vendorRoot = path.join(extensionRoot, 'vendor', 'desktop-app');
const siblingDesktopApp = path.resolve(extensionRoot, '..', 'EmulatorDesktopApp');

/** vsce --target value → .NET RID */
const TARGET_TO_RID = {
  'win32-x64': 'win-x64',
  'win32-arm64': 'win-arm64',
  'darwin-x64': 'osx-x64',
  'darwin-arm64': 'osx-arm64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
};

const ALL_TARGETS = Object.keys(TARGET_TO_RID);
const REQUIRED_DESKTOP_APP_FEATURES = ['headless-attach-v1'];
/** Default RIDs bundled into `--universal` (one vsix for Mac + Windows). */
const UNIVERSAL_TARGETS = ['win32-x64', 'darwin-arm64', 'darwin-x64'];
const BEFORE_VSIX = path.join(distDir, 'emulator-stream-run-0.2.0-win32-x64.vsix');
const BEFORE_BYTES = fs.existsSync(BEFORE_VSIX) ? fs.statSync(BEFORE_VSIX).size : null;

const argv = process.argv.slice(2);
const buildAll = argv.includes('--all');
const buildUniversal = argv.includes('--universal');
const targetIdx = argv.indexOf('--target');
const explicitTarget = targetIdx >= 0 ? argv[targetIdx + 1] : null;

let mode; // 'single' | 'all' | 'universal'
let targets;

if (buildUniversal) {
  mode = 'universal';
  targets = UNIVERSAL_TARGETS.slice();
} else if (buildAll) {
  mode = 'all';
  targets = ALL_TARGETS.slice();
} else if (explicitTarget) {
  mode = 'single';
  if (!TARGET_TO_RID[explicitTarget]) {
    fatal(`Unknown --target "${explicitTarget}". Supported: ${ALL_TARGETS.join(', ')}`);
  }
  targets = [explicitTarget];
} else {
  mode = 'single';
  targets = [hostVsceTarget()];
}

fs.mkdirSync(distDir, { recursive: true });

if (mode === 'universal') {
  let allRemoved = [];
  let outFile = '';
  step(`Package universal (Mac + Windows)`, () => {
    fs.rmSync(vendorRoot, { recursive: true, force: true });
    fs.mkdirSync(vendorRoot, { recursive: true });
    const builds = [];
    for (const vsceTarget of targets) {
      const rid = TARGET_TO_RID[vsceTarget];
      log(`── publish ${vsceTarget} (rid=${rid})`);
      const removed = publishDesktopAppForRid(rid, path.join(vendorRoot, rid));
      writeBuildInfo(path.join(vendorRoot, rid), rid);
      allRemoved = allRemoved.concat(removed);
      builds.push({ rid, vsceTarget });
    }
    writeSupportedRidsManifest(builds);
    outFile = runVsceUniversal();
    const report = renderReport({
      label: 'SIZE REPORT — universal (Mac + Windows)',
      vendorRoot,
      vsixPath: outFile,
      removed: allRemoved,
    });
    process.stdout.write(report + '\n');
  });
} else {
  for (const vsceTarget of targets) {
    const rid = TARGET_TO_RID[vsceTarget];
    let removed = [];
    let outFile = '';
    step(`Package for ${vsceTarget} (rid=${rid})`, () => {
      fs.rmSync(vendorRoot, { recursive: true, force: true });
      fs.mkdirSync(vendorRoot, { recursive: true });
      removed = publishDesktopAppForRid(rid);
      writeBuildInfo(vendorRoot, rid);
      outFile = runVsce(vsceTarget);
      const report = renderReport({
        label: `SIZE REPORT — ${vsceTarget}`,
        vendorRoot,
        vsixPath: outFile,
        removed,
      });
      process.stdout.write(report + '\n');
    });
  }
}

if (BEFORE_BYTES != null && mode === 'single' && targets.length === 1 && targets[0] === 'win32-x64') {
  const afterPath = path.join(distDir, `emulator-stream-run-${readVersion()}-win32-x64.vsix`);
  if (fs.existsSync(afterPath)) {
    const after = fs.statSync(afterPath).size;
    process.stdout.write(
      `\nVSIX before optimization: ${formatBytes(BEFORE_BYTES)}\n` +
      `VSIX after optimization:  ${formatBytes(after)} (${((1 - after / BEFORE_BYTES) * 100).toFixed(1)}% smaller)\n`
    );
  }
}

process.stdout.write(`\n✓ done. Artefact(s) in ${distDir}\n`);

// ── steps ───────────────────────────────────────────────────────────────

function publishDesktopAppForRid(rid, destDir = vendorRoot) {
  if (!fs.existsSync(siblingDesktopApp)) {
    fatal(
      `Cannot find ../EmulatorDesktopApp at ${siblingDesktopApp}. ` +
      `This script requires the extension and the .NET project side-by-side.`
    );
  }
  log(`dotnet publish -c Release -r ${rid}`);
  execFileSync(
    'dotnet',
    [
      'publish', '-c', 'Release', '-r', rid,
      '--self-contained', 'false',
      '-p:UseAppHost=true',
      '-p:DebugType=none',
      '-p:DebugSymbols=false',
      '-p:CopyDebugSymbolFilesFromPackages=false',
      '-p:InvariantGlobalization=true',
      '-p:PublishReadyToRun=false',
    ],
    { cwd: siblingDesktopApp, stdio: 'inherit' }
  );
  const targetFramework = readTargetFramework(siblingDesktopApp);
  const publishDir = path.join(siblingDesktopApp, 'bin', 'Release', targetFramework, rid, 'publish');
  if (!fs.existsSync(publishDir)) fatal(`publish output missing at ${publishDir}`);

  if (rid === 'win-x64' || rid === 'win-arm64') {
    ensureWinFfmpegInPublishDir(publishDir);
    if (!hasWinFfmpeg(publishDir)) {
      fatal(`Windows FFmpeg DLLs missing in ${publishDir}/ffmpeg/win-x64 after publish`);
    }
  }

  const prune = prunePublishDir(publishDir, rid);
  log(`pruned publish output: ${formatBytes(prune.beforeBytes)} → ${formatBytes(prune.afterBytes)} (${prune.removed.length} files)`);

  copyRecursive(publishDir, destDir);
  log(`copied ${publishDir} → ${destDir}`);
  return prune.removed;
}

function writeSupportedRidsManifest(builds) {
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    rids: builds.map((b) => ({ rid: b.rid, vsceTarget: b.vsceTarget })),
  };
  fs.writeFileSync(
    path.join(vendorRoot, 'SUPPORTED_RIDS.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  log(`wrote SUPPORTED_RIDS.json (${builds.length} platforms)`);
}

function runVsceUniversal() {
  fs.rmSync(path.join(extensionRoot, 'out'), { recursive: true, force: true });

  const tscBin = path.join(extensionRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  execFileSync(tscBin, ['-p', path.join(extensionRoot, 'tsconfig.json')], {
    cwd: extensionRoot, stdio: 'inherit',
  });

  const version = readVersion();
  const outFile = path.join(distDir, `emulator-stream-run-${version}.vsix`);
  try { fs.unlinkSync(outFile); } catch { /* not present */ }

  const vsceBin = path.join(extensionRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');
  execFileSync(
    vsceBin,
    ['package', '--out', outFile, '--allow-star-activation'],
    { cwd: extensionRoot, stdio: 'inherit' }
  );
  log(`→ ${outFile}`);
  return outFile;
}

function writeBuildInfo(dir, rid) {
  let gitSha = null;
  try {
    gitSha = execFileSync('git', ['rev-parse', 'short', 'HEAD'], {
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

function runVsce(vsceTarget) {
  fs.rmSync(path.join(extensionRoot, 'out'), { recursive: true, force: true });

  const tscBin = path.join(extensionRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  execFileSync(tscBin, ['-p', path.join(extensionRoot, 'tsconfig.json')], {
    cwd: extensionRoot, stdio: 'inherit',
  });

  const version = readVersion();
  const outFile = path.join(distDir, `emulator-stream-run-${version}-${vsceTarget}.vsix`);
  try { fs.unlinkSync(outFile); } catch { /* not present */ }

  const vsceBin = path.join(extensionRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');
  execFileSync(
    vsceBin,
    ['package', '--target', vsceTarget, '--out', outFile, '--allow-star-activation'],
    { cwd: extensionRoot, stdio: 'inherit' }
  );
  log(`→ ${outFile}`);
  return outFile;
}

// ── helpers ─────────────────────────────────────────────────────────────

function hostVsceTarget() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'linux')  return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  if (platform === 'win32')  return arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
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
