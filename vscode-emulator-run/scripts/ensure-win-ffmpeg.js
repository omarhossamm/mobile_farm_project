#!/usr/bin/env node
/**
 * Ensure Gyan codexffmpeg 8.1 shared DLLs exist under
 * `<publishDir>/ffmpeg/win-x64/`.
 *
 * Cross-compiling win-x64 from macOS/Linux should pull these in via
 * FFmpeg.Windows.targets, but this script is a belt-and-suspenders fallback
 * used by package.js / publish-desktop-app.js when the MSBuild step was
 * skipped or failed silently (e.g. no network during dotnet publish).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FFMPEG_ZIP_URL =
  'https://github.com/GyanD/codexffmpeg/releases/download/8.1/ffmpeg-8.1-full_build-shared.zip';

const REQUIRED_DLLS = [
  'avutil-60.dll',
  'swresample-6.dll',
  'swscale-9.dll',
  'avcodec-62.dll',
];

function winFfmpegDir(publishDir) {
  return path.join(publishDir, 'ffmpeg', 'win-x64');
}

function hasWinFfmpeg(publishDir) {
  const dir = winFfmpegDir(publishDir);
  return REQUIRED_DLLS.every((name) => fs.existsSync(path.join(dir, name)));
}

/**
 * @param {string} publishDir absolute path to dotnet publish output
 * @returns {boolean} true when DLLs were downloaded/copied; false when already present
 */
function ensureWinFfmpegInPublishDir(publishDir) {
  if (hasWinFfmpeg(publishDir)) return false;

  const cacheRoot = path.join(
    process.env.HOME || process.env.USERPROFILE || '/tmp',
    '.cache',
    'EmulatorDesktopApp',
    'ffmpeg-cache'
  );
  fs.mkdirSync(cacheRoot, { recursive: true });
  const zipPath = path.join(cacheRoot, 'ffmpeg-8.1-full_build-shared.zip');
  if (!fs.existsSync(zipPath)) {
    process.stdout.write(`  [ffmpeg] downloading Gyan codexffmpeg 8.1 …\n`);
    execFileSync('curl', ['-fsSL', '-o', zipPath, FFMPEG_ZIP_URL], { stdio: 'inherit' });
  }

  const dest = winFfmpegDir(publishDir);
  fs.mkdirSync(dest, { recursive: true });
  const extractDir = path.join(cacheRoot, 'extract');
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync('tar', ['-xf', zipPath, '-C', extractDir], { stdio: 'inherit' });

  const binDir = findBinDir(extractDir);
  if (!binDir) {
    throw new Error('Could not locate bin/avutil-60.dll inside extracted FFmpeg archive');
  }

  for (const name of REQUIRED_DLLS) {
    const src = path.join(binDir, name);
    if (!fs.existsSync(src)) {
      throw new Error(`FFmpeg archive missing required DLL: ${name}`);
    }
    fs.copyFileSync(src, path.join(dest, name));
  }

  fs.rmSync(extractDir, { recursive: true, force: true });
  process.stdout.write(`  [ffmpeg] copied ${REQUIRED_DLLS.length} DLL(s) → ${dest}\n`);
  return true;
}

function findBinDir(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    const bin = path.join(dir, 'bin');
    if (fs.existsSync(bin) && fs.statSync(bin).isDirectory()) {
      if (fs.existsSync(path.join(bin, 'avutil-60.dll'))) return bin;
    }
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        if (fs.statSync(full).isDirectory()) stack.push(full);
      } catch { /* ignore */ }
    }
  }
  return null;
}

module.exports = {
  REQUIRED_DLLS,
  hasWinFfmpeg,
  ensureWinFfmpegInPublishDir,
};
