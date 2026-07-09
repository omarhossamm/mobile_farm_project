#!/usr/bin/env node
/**
 * Post-publish pruning for platform-specific offline VSIX bundles.
 *
 * Removes dev artefacts, wrong-platform Avalonia satellites, and any
 * native libraries that cannot be loaded on the target RID.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** FFmpeg shared DLLs required for WebRTC H.264 decode (SIPSorcery decode path only). */
const WINDOWS_FFMPEG_DECODE_DLLS = new Set([
  'avutil-60.dll',
  'swresample-6.dll',
  'swscale-9.dll',
  'avcodec-62.dll',
]);

/** Glob-style names removed per RID (basename match). */
const PLATFORM_EXCLUDES = {
  'win-x64': [
    'Avalonia.X11.dll',
    'Avalonia.Native.dll',
    'Avalonia.FreeDesktop.dll',
    'Avalonia.FreeDesktop.AtSpi.dll',
    'Avalonia.Metal.dll',
    'Avalonia.DesignerSupport.dll',
    'Avalonia.Remote.Protocol.dll',
    'Tmds.DBus.Protocol.dll',
  ],
  'win-arm64': [
    'Avalonia.X11.dll',
    'Avalonia.Native.dll',
    'Avalonia.FreeDesktop.dll',
    'Avalonia.FreeDesktop.AtSpi.dll',
    'Avalonia.Metal.dll',
    'Avalonia.DesignerSupport.dll',
    'Avalonia.Remote.Protocol.dll',
    'Tmds.DBus.Protocol.dll',
  ],
  'osx-x64': [
    'Avalonia.Win32.dll',
    'Avalonia.Win32.Automation.dll',
    'av_libglesv2.dll',
    'Avalonia.X11.dll',
    'Avalonia.FreeDesktop.dll',
    'Avalonia.FreeDesktop.AtSpi.dll',
    'Tmds.DBus.Protocol.dll',
    'Avalonia.DesignerSupport.dll',
    'Avalonia.Remote.Protocol.dll',
  ],
  'osx-arm64': [
    'Avalonia.Win32.dll',
    'Avalonia.Win32.Automation.dll',
    'av_libglesv2.dll',
    'Avalonia.X11.dll',
    'Avalonia.FreeDesktop.dll',
    'Avalonia.FreeDesktop.AtSpi.dll',
    'Tmds.DBus.Protocol.dll',
    'Avalonia.DesignerSupport.dll',
    'Avalonia.Remote.Protocol.dll',
  ],
  'linux-x64': [
    'Avalonia.Win32.dll',
    'Avalonia.Win32.Automation.dll',
    'av_libglesv2.dll',
    'Avalonia.Native.dll',
    'Avalonia.Metal.dll',
    'Avalonia.DesignerSupport.dll',
    'Avalonia.Remote.Protocol.dll',
  ],
  'linux-arm64': [
    'Avalonia.Win32.dll',
    'Avalonia.Win32.Automation.dll',
    'av_libglesv2.dll',
    'Avalonia.Native.dll',
    'Avalonia.Metal.dll',
    'Avalonia.DesignerSupport.dll',
    'Avalonia.Remote.Protocol.dll',
  ],
};

const DEV_ARTEFACT_GLOBS = [
  /\.pdb$/i,
  /\.xml$/i,
  /\.mdb$/i,
  /\.dbg$/i,
  /\.map$/i,
  /\.ilk$/i,
  /\.exp$/i,
  /\.lib$/i,
  /\.nupkg$/i,
];

/**
 * @param {string} publishDir
 * @param {string} rid
 * @returns {{ removed: Array<{path:string, bytes:number, reason:string}>, beforeBytes: number, afterBytes: number }}
 */
function prunePublishDir(publishDir, rid) {
  const removed = [];
  const beforeBytes = dirSize(publishDir);

  walkFiles(publishDir, (filePath) => {
    const base = path.basename(filePath);
    const rel = path.relative(publishDir, filePath).replace(/\\/g, '/');
    let reason = null;

    if (DEV_ARTEFACT_GLOBS.some((re) => re.test(base))) {
      reason = 'dev artefact';
    } else if (rel.startsWith('ffmpeg/win-x64/') && (rid === 'win-x64' || rid === 'win-arm64')) {
      if (!WINDOWS_FFMPEG_DECODE_DLLS.has(base)) {
        reason = 'unused FFmpeg DLL (decode-only path)';
      }
    } else {
      const excludes = PLATFORM_EXCLUDES[rid] || [];
      if (excludes.includes(base)) {
        reason = 'wrong-platform assembly';
      }
    }

    if (reason) {
      const bytes = safeSize(filePath);
      fs.rmSync(filePath, { force: true });
      removed.push({ path: rel, bytes, reason });
    }
  });

  // Drop empty directories left behind.
  walkDirsBottomUp(publishDir, (dir) => {
    if (dir === publishDir) return;
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* ignore */ }
  });

  const afterBytes = dirSize(publishDir);
  return { removed, beforeBytes, afterBytes };
}

function walkFiles(root, fn) {
  for (const entry of fs.readdirSync(root)) {
    const full = path.join(root, entry);
    const st = fs.lstatSync(full);
    if (st.isDirectory()) walkFiles(full, fn);
    else if (st.isFile()) fn(full);
  }
}

function walkDirsBottomUp(root, fn) {
  for (const entry of fs.readdirSync(root)) {
    const full = path.join(root, entry);
    if (fs.lstatSync(full).isDirectory()) walkDirsBottomUp(full, fn);
  }
  fn(root);
}

function dirSize(root) {
  let total = 0;
  walkFiles(root, (f) => { total += safeSize(f); });
  return total;
}

function safeSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

module.exports = {
  WINDOWS_FFMPEG_DECODE_DLLS,
  prunePublishDir,
};
