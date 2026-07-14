/**
 * Resolve the ADB binary at runtime.
 *
 * Order:
 *   1. ADB_PATH env (explicit override)
 *   2. `adb` on PATH (where/which)
 *   3. ANDROID_HOME / ANDROID_SDK_ROOT platform-tools
 *   4. Common SDK install locations per OS
 *
 * Result is cached for the process lifetime.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ADB_BIN = process.platform === 'win32' ? 'adb.exe' : 'adb';

let cached = null;

function isRunnable(adbPath) {
  if (!adbPath) return false;
  try {
    execFileSync(adbPath, ['version'], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

function findAdbOnPath() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where.exe', ['adb'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true
      });
      return out.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
    }

    const out = execFileSync('which', ['adb'], {
      encoding: 'utf8',
      timeout: 3000
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function sdkRoots() {
  const roots = [];
  if (process.env.ANDROID_HOME) roots.push(process.env.ANDROID_HOME);
  if (process.env.ANDROID_SDK_ROOT) roots.push(process.env.ANDROID_SDK_ROOT);

  const home = os.homedir();
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      roots.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
    }
    roots.push(path.join(home, 'AppData', 'Local', 'Android', 'Sdk'));
    roots.push(path.join(home, 'Android', 'Sdk'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Android', 'sdk'));
    roots.push('/usr/local/share/android-sdk');
    roots.push('/opt/android-sdk');
  } else {
    roots.push(path.join(home, 'Android', 'Sdk'));
    roots.push('/usr/lib/android-sdk');
    roots.push('/opt/android-sdk');
  }

  return [...new Set(roots.filter(Boolean))];
}

function candidatePaths() {
  const candidates = [];

  if (process.env.ADB_PATH) {
    candidates.push(process.env.ADB_PATH);
  }

  for (const root of sdkRoots()) {
    candidates.push(path.join(root, 'platform-tools', ADB_BIN));
  }

  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/adb');
    candidates.push('/usr/local/bin/adb');
  }

  return [...new Set(candidates.filter(Boolean))];
}

/**
 * @returns {{ path: string, source: string, found: boolean }}
 */
function resolveAdbPath() {
  if (cached) return cached;

  if (process.env.ADB_PATH && isRunnable(process.env.ADB_PATH)) {
    cached = { path: process.env.ADB_PATH, source: 'ADB_PATH', found: true };
    return cached;
  }

  const onPath = findAdbOnPath();
  if (onPath && isRunnable(onPath)) {
    cached = { path: onPath, source: 'PATH', found: true };
    return cached;
  }

  if (isRunnable('adb')) {
    cached = { path: 'adb', source: 'PATH', found: true };
    return cached;
  }

  for (const candidate of candidatePaths()) {
    if (process.env.ADB_PATH && candidate === process.env.ADB_PATH) continue;
    try {
      if (!fs.existsSync(candidate)) continue;
    } catch {
      continue;
    }
    if (isRunnable(candidate)) {
      cached = { path: candidate, source: 'sdk-scan', found: true };
      return cached;
    }
  }

  cached = {
    path: process.env.ADB_PATH || 'adb',
    source: 'fallback',
    found: false
  };
  return cached;
}

function getAdbPath() {
  return resolveAdbPath().path;
}

/** Clear cache (tests / re-resolve after installing SDK). */
function clearAdbPathCache() {
  cached = null;
}

module.exports = {
  resolveAdbPath,
  getAdbPath,
  clearAdbPathCache
};
