'use strict';

/**
 * Thin wrapper over `xcrun simctl` for iOS Simulator discovery + lifecycle.
 * No idb dependency — pure Apple tooling, available with any Xcode install.
 *
 * @module lib/simctl
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const { createLogger } = require('./logger');

const execFileAsync = promisify(execFile);
const logger = createLogger('SIMCTL');

const XCRUN = 'xcrun';

function baseArgs(extra) {
  return ['simctl', ...extra];
}

/**
 * List all simulator devices grouped by runtime. Returns a flat array of
 * { udid, name, state, deviceTypeIdentifier, runtime, isAvailable }.
 */
async function listDevices() {
  let out;
  try {
    const r = await execFileAsync(XCRUN, baseArgs(['list', 'devices', '--json']), {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024
    });
    out = r.stdout;
  } catch (err) {
    logger.warn('simctl list devices failed', { error: err.message });
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    logger.warn('simctl JSON parse failed', { error: err.message });
    return [];
  }

  const devices = [];
  const byRuntime = parsed.devices || {};
  for (const runtime of Object.keys(byRuntime)) {
    for (const d of byRuntime[runtime]) {
      if (d.isAvailable === false) continue;
      devices.push({
        udid: d.udid,
        name: d.name,
        state: d.state,                       // 'Booted' | 'Shutdown' | ...
        deviceTypeIdentifier: d.deviceTypeIdentifier || '',
        runtime: runtime.replace('com.apple.CoreSimulator.SimRuntime.', ''),
        isAvailable: d.isAvailable !== false
      });
    }
  }
  return devices;
}

async function getDevice(udid) {
  const all = await listDevices();
  return all.find((d) => d.udid?.toLowerCase() === String(udid).toLowerCase()) || null;
}

async function isBooted(udid) {
  const d = await getDevice(udid);
  return d?.state === 'Booted';
}

async function boot(udid) {
  try {
    await execFileAsync(XCRUN, baseArgs(['boot', udid]), { timeout: 60_000 });
    return { success: true };
  } catch (err) {
    // simctl exits non-zero if already booted; treat that as success.
    if (/Unable to boot device in current state: Booted/i.test(err.stderr || err.message || '')) {
      return { success: true, alreadyRunning: true };
    }
    return { success: false, error: err.stderr || err.message };
  }
}

async function shutdown(udid) {
  try {
    await execFileAsync(XCRUN, baseArgs(['shutdown', udid]), { timeout: 30_000 });
    return { success: true };
  } catch (err) {
    if (/current state: Shutdown/i.test(err.stderr || err.message || '')) {
      return { success: true };
    }
    return { success: false, error: err.stderr || err.message };
  }
}

/**
 * Capture a PNG screenshot of the booted simulator to a local file path.
 * The server runs on the same Mac as the simulator, so `localPath` lands
 * directly on the host filesystem (e.g. the user's Desktop).
 */
async function screenshot(udid, localPath) {
  try {
    await execFileAsync(XCRUN, baseArgs(['io', udid, 'screenshot', localPath]), { timeout: 15_000 });
    return { success: true, output: localPath };
  } catch (err) {
    return { success: false, error: err.stderr || err.message };
  }
}

/**
 * Wait until the device reaches 'Booted' and its system app is responsive.
 */
async function waitUntilBooted(udid, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isBooted(udid)) {
      try {
        await execFileAsync(XCRUN, baseArgs(['bootstatus', udid, '-b']), { timeout: 45_000 });
      } catch {
        try {
          await execFileAsync(XCRUN, baseArgs(['bootstatus', udid]), { timeout: 20_000 });
        } catch {
          /* bootstatus unavailable/old Xcode; booted state is final fallback */
        }
      }
      return true;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  return false;
}

/**
 * Bring Simulator.app to foreground and target a specific booted UDID.
 */
async function openSimulatorApp(udid) {
  try {
    await execFileAsync('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid], {
      timeout: 15_000
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.stderr || err.message };
  }
}

module.exports = {
  listDevices,
  getDevice,
  isBooted,
  boot,
  shutdown,
  screenshot,
  waitUntilBooted,
  openSimulatorApp
};
