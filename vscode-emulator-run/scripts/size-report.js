#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @param {string} root
 * @returns {{ folders: Array<{path:string, bytes:number}>, files: Array<{path:string, bytes:number}>, total: number }}
 */
function analyzeTree(root) {
  const folders = new Map();
  const files = [];
  let total = 0;

  walk(root, (filePath) => {
    const rel = path.relative(root, filePath).replace(/\\/g, '/');
    const bytes = safeSize(filePath);
    total += bytes;
    files.push({ path: rel, bytes });

    let dir = path.dirname(rel);
    while (dir && dir !== '.') {
      folders.set(dir, (folders.get(dir) || 0) + bytes);
      dir = path.dirname(dir);
    }
    folders.set('.', (folders.get('.') || 0) + bytes);
  });

  return {
    folders: [...folders.entries()]
      .map(([p, bytes]) => ({ path: p, bytes }))
      .filter((e) => e.bytes >= 1024 * 1024)
      .sort((a, b) => b.bytes - a.bytes),
    files: files
      .filter((f) => f.bytes >= 500 * 1024)
      .sort((a, b) => b.bytes - a.bytes),
    total,
  };
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function renderReport({ label, vendorRoot, vsixPath, removed }) {
  const analysis = analyzeTree(vendorRoot);
  const lines = [];
  lines.push(`\n${'='.repeat(72)}`);
  lines.push(`${label}`);
  lines.push('='.repeat(72));
  lines.push(`Vendor root : ${vendorRoot}`);
  lines.push(`Vendor total: ${formatBytes(analysis.total)}`);
  if (vsixPath && fs.existsSync(vsixPath)) {
    lines.push(`VSIX size   : ${formatBytes(fs.statSync(vsixPath).size)} (${path.basename(vsixPath)})`);
  }

  if (removed?.length) {
    const saved = removed.reduce((s, r) => s + r.bytes, 0);
    lines.push(`\nPruned ${removed.length} file(s), reclaimed ${formatBytes(saved)} uncompressed:`);
    for (const r of removed.sort((a, b) => b.bytes - a.bytes).slice(0, 20)) {
      lines.push(`  - ${r.path}  (${formatBytes(r.bytes)})  [${r.reason}]`);
    }
    if (removed.length > 20) lines.push(`  … and ${removed.length - 20} more`);
  }

  lines.push('\nFolders ≥ 1 MB:');
  for (const f of analysis.folders) {
    lines.push(`  ${formatBytes(f.bytes).padStart(10)}  ${f.path === '.' ? '(root)' : f.path}`);
  }

  lines.push('\nFiles ≥ 500 KB:');
  for (const f of analysis.files) {
    lines.push(`  ${formatBytes(f.bytes).padStart(10)}  ${f.path}`);
  }

  // Dependency roll-up by top-level name.
  const deps = new Map();
  for (const f of analysis.files) {
    const top = f.path.split('/')[0];
    deps.set(top, (deps.get(top) || 0) + f.bytes);
  }
  lines.push('\nMajor dependency groups (files ≥ 500 KB rolled up):');
  for (const [name, bytes] of [...deps.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${formatBytes(bytes).padStart(10)}  ${name}`);
  }

  return lines.join('\n');
}

function walk(root, onFile) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root)) {
    const full = path.join(root, entry);
    const st = fs.lstatSync(full);
    if (st.isDirectory()) walk(full, onFile);
    else if (st.isFile()) onFile(full);
  }
}

function safeSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

module.exports = { analyzeTree, formatBytes, renderReport };
