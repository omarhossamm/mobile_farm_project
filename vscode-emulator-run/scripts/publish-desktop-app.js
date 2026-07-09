#!/usr/bin/env node
/**
 * Build EmulatorDesktopApp for every supported RID, zip the outputs,
 * compute SHA256s, and write two artefacts the extension consumes:
 *
 *   1. `dist/desktop-app-releases/<version>/*.zip` — the archives you
 *      then upload to GitHub Releases (or any HTTPS host).
 *   2. `dist/desktop-app-releases/<version>/manifest.json` — the live
 *      manifest that the running extension polls for background
 *      updates. Upload this to the "latest" location the extension
 *      knows about via `PINNED_MANIFEST.updateManifestUrl`.
 *   3. `src/desktopAppManifest.ts` (rewritten) — the pinned
 *      manifest embedded in the extension itself. Commit this file
 *      alongside the version bump so the next `.vsix` knows exactly
 *      where the artefacts live.
 *
 * The version, base URL, and update-manifest URL are all read from
 * command-line args or (falling back) `--version` from package.json.
 *
 * Usage:
 *
 *     node scripts/publish-desktop-app.js \
 *       --version 0.2.1 \
 *       --base-url https://github.com/ORG/REPO/releases/download/desktop-app-v0.2.1 \
 *       --update-manifest-url https://raw.githubusercontent.com/ORG/REPO/main/dist/desktop-app-releases/latest/manifest.json
 *
 *     # Then upload the artefacts:
 *     gh release create desktop-app-v0.2.1 --title "Desktop App 0.2.1" \
 *       dist/desktop-app-releases/0.2.1/*.zip \
 *       dist/desktop-app-releases/0.2.1/manifest.json
 *
 * The `<baseUrl>/manifest.json` lookup is optional — leave
 * `--update-manifest-url` blank to disable background updates.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { ensureWinFfmpegInPublishDir, hasWinFfmpeg } = require('./ensure-win-ffmpeg');
const { prunePublishDir } = require('./prune-publish');

const extensionRoot = path.resolve(__dirname, '..');
const siblingDesktopApp = path.resolve(extensionRoot, '..', 'EmulatorDesktopApp');
const releasesRoot = path.join(extensionRoot, 'dist', 'desktop-app-releases');

const ALL_RIDS = [
  'win-x64', 'win-arm64',
  'osx-x64', 'osx-arm64',
  'linux-x64', 'linux-arm64',
];

const REQUIRED_DESKTOP_APP_FEATURES = ['headless-attach-v1'];

const args = parseArgs(process.argv.slice(2));
const version = args.version || readVersion();
const baseUrl = (args['base-url'] || '').replace(/\/+$/, '');
const updateManifestUrl = args['update-manifest-url'] || '';
const requestedRids = args.rid ? args.rid.split(',').map(s => s.trim()).filter(Boolean) : ALL_RIDS.slice();
for (const r of requestedRids) if (!ALL_RIDS.includes(r)) fatal(`unknown RID "${r}"`);

if (!version) fatal('missing --version');
if (!baseUrl) fatal('missing --base-url (e.g. https://github.com/ORG/REPO/releases/download/desktop-app-v<version>)');

const publishDir = path.join(releasesRoot, version);
fs.mkdirSync(publishDir, { recursive: true });

const gitSha = readGitSha();

const publishedAssets = {};
for (const rid of requestedRids) {
  step(`publish ${rid}`, () => {
    const archive = buildAndZipForRid(rid, publishDir);
    const sha256 = sha256File(archive.zipPath);
    const size = fs.statSync(archive.zipPath).size;
    publishedAssets[rid] = {
      // Absolute URL — GitHub Releases yields immutable download links,
      // this makes the pinned manifest work even when the user sets
      // no baseUrl override.
      url: `${baseUrl}/${archive.filename}`,
      sha256,
      size,
    };
    log(`✓ ${archive.filename}  sha256=${sha256.slice(0, 16)}…  ${(size/1024/1024).toFixed(1)} MB`);
  });
}

const liveManifest = {
  schemaVersion: 1,
  latest: version,
  generatedAt: new Date().toISOString(),
  gitSha,
  versions: {
    [version]: {
      features: REQUIRED_DESKTOP_APP_FEATURES.slice(),
      assets: publishedAssets,
    },
  },
};

const liveManifestPath = path.join(publishDir, 'manifest.json');
fs.writeFileSync(liveManifestPath, JSON.stringify(liveManifest, null, 2) + '\n');
log(`wrote ${liveManifestPath}`);

rewritePinnedManifest({
  requiredVersion: version,
  gitSha,
  publishedAssets,
  defaultBaseUrl: baseUrl,
  updateManifestUrl,
});

process.stdout.write(`\n✓ done. Upload the artefacts:\n`);
process.stdout.write(`    gh release create desktop-app-v${version} \\\n`);
process.stdout.write(`      --title "Desktop App ${version}" \\\n`);
for (const rid of requestedRids) {
  process.stdout.write(`      ${path.relative(process.cwd(), path.join(publishDir, publishedAssets[rid].url.split('/').pop()))} \\\n`);
}
process.stdout.write(`      ${path.relative(process.cwd(), liveManifestPath)}\n`);
process.stdout.write(`\n    # Commit + release the extension .vsix:\n`);
process.stdout.write(`    git add src/desktopAppManifest.ts && git commit -m "release: desktop-app ${version}"\n`);
process.stdout.write(`    npm run package    # produces the slim vsix\n`);

// ── steps ───────────────────────────────────────────────────────────────

function buildAndZipForRid(rid, outDir) {
  if (!fs.existsSync(siblingDesktopApp)) {
    fatal(`Cannot find ../EmulatorDesktopApp at ${siblingDesktopApp}`);
  }
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
  const publishOutput = path.join(siblingDesktopApp, 'bin', 'Release', targetFramework, rid, 'publish');
  if (!fs.existsSync(publishOutput)) fatal(`publish output missing at ${publishOutput}`);

  if (rid === 'win-x64' || rid === 'win-arm64') {
    ensureWinFfmpegInPublishDir(publishOutput);
    if (!hasWinFfmpeg(publishOutput)) {
      fatal(`Windows FFmpeg DLLs missing in ${publishOutput}/ffmpeg/win-x64 after publish`);
    }
  }
  prunePublishDir(publishOutput, rid);

  writeBuildInfo(publishOutput, rid);

  const filename = `emulator-desktop-app-${version}-${rid}.zip`;
  const zipPath = path.join(outDir, filename);
  try { fs.unlinkSync(zipPath); } catch { /* ignore */ }

  // Use adm-zip (already a runtime dep of the extension) to keep this
  // toolchain platform-independent. Native `zip`/`7z` binaries aren't
  // available on every CI image.
  const AdmZip = require(path.join(extensionRoot, 'node_modules', 'adm-zip'));
  const zip = new AdmZip();
  addFolderToZip(zip, publishOutput, '');
  zip.writeZip(zipPath);

  return { zipPath, filename };
}

/** Recurse walk, add each file at its RELATIVE path inside the zip. */
function addFolderToZip(zip, rootDir, prefix) {
  for (const entry of fs.readdirSync(rootDir)) {
    const full = path.join(rootDir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const st = fs.lstatSync(full);
    if (st.isDirectory()) {
      addFolderToZip(zip, full, rel);
      continue;
    }
    zip.addLocalFile(full, prefix || undefined);
    // Preserve executable bit on Unix.
    if (process.platform !== 'win32' && (st.mode & 0o100)) {
      // adm-zip supports setting attr via getEntry after adding.
      const entryObj = zip.getEntry(rel);
      if (entryObj) entryObj.attr = (st.mode & 0xffff) << 16;
    }
  }
}

function writeBuildInfo(dir, rid) {
  const info = {
    builtAt: new Date().toISOString(),
    rid,
    gitSha,
    features: REQUIRED_DESKTOP_APP_FEATURES.slice(),
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    packagedBy: 'scripts/publish-desktop-app.js',
    version,
  };
  fs.writeFileSync(path.join(dir, 'BUILD_INFO.json'), JSON.stringify(info, null, 2) + '\n');
}

function rewritePinnedManifest({ requiredVersion, gitSha, publishedAssets, defaultBaseUrl, updateManifestUrl }) {
  const manifestSrc = path.join(extensionRoot, 'src', 'desktopAppManifest.ts');
  let text = fs.readFileSync(manifestSrc, 'utf8');

  // Turn `publishedAssets` into a TypeScript object literal keyed by RID.
  const assetLines = Object.entries(publishedAssets).map(([rid, asset]) => {
    return `  '${rid}': ${JSON.stringify(asset)},`;
  }).join('\n');

  const pinnedRegex = /export const PINNED_MANIFEST: PinnedManifest = \{[\s\S]*?\};/m;
  const replacement =
`export const PINNED_MANIFEST: PinnedManifest = {
  requiredVersion: ${JSON.stringify(requiredVersion)},
  generatedAt: ${JSON.stringify(new Date().toISOString())},${gitSha ? `\n  gitSha: ${JSON.stringify(gitSha)},` : ''}
  defaultBaseUrl: ${JSON.stringify(defaultBaseUrl)},
  updateManifestUrl: ${JSON.stringify(updateManifestUrl)},
  assets: {
${assetLines}
  },
};`;

  if (!pinnedRegex.test(text)) {
    fatal('Could not locate PINNED_MANIFEST block in src/desktopAppManifest.ts (was it hand-edited?)');
  }
  text = text.replace(pinnedRegex, replacement);
  fs.writeFileSync(manifestSrc, text);
  log(`updated ${manifestSrc}`);
}

// ── helpers ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) { out[key] = 'true'; }
      else { out[key] = next; i++; }
    }
  }
  return out;
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
  return pkg.version;
}

function readGitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: extensionRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

function readTargetFramework(dir) {
  const csproj = path.join(dir, 'EmulatorDesktopApp.csproj');
  const xml = fs.readFileSync(csproj, 'utf8');
  const m = xml.match(/<TargetFramework>([^<]+)<\/TargetFramework>/);
  if (!m) fatal('Could not read <TargetFramework> from EmulatorDesktopApp.csproj');
  return m[1].trim();
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
