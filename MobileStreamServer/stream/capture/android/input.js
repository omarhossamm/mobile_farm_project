const { spawn } = require('child_process');
const { streamConfig } = require('../../../lib/config');

function shell(deviceId, cmd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(streamConfig.adbPath, ['-s', deviceId, 'shell', cmd], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(err || `shell exit ${code}`));
    });
    proc.on('error', reject);
  });
}

function parseWmSizeOutput(out) {
  const physical = out.match(/Physical size:\s*(\d+)x(\d+)/i);
  if (physical) {
    return { width: parseInt(physical[1], 10), height: parseInt(physical[2], 10) };
  }
  const override = out.match(/Override size:\s*(\d+)x(\d+)/i);
  if (override) {
    return { width: parseInt(override[1], 10), height: parseInt(override[2], 10) };
  }
  const any = out.match(/(\d+)x(\d+)/);
  if (any) {
    return { width: parseInt(any[1], 10), height: parseInt(any[2], 10) };
  }
  return null;
}

/**
 * Capture stdout of an `adb shell` invocation. Never rejects — returns '' on
 * error so callers can fall back to defaults instead of failing the whole tap.
 */
function shellCapture(deviceId, cmd) {
  return new Promise((resolve) => {
    const args = ['-s', deviceId, 'shell', ...(Array.isArray(cmd) ? cmd : [cmd])];
    const proc = spawn(streamConfig.adbPath, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => resolve(out));
    proc.on('error', () => resolve(''));
  });
}

/**
 * Resolve the device's CURRENT display rotation in quarter-turns:
 *   0 → 0°   1 → 90°   2 → 180°   3 → 270°
 *
 * Tries `dumpsys input` for `SurfaceOrientation`, then falls back to the
 * `user_rotation` system setting. Returns 0 if nothing parses — this is the
 * safe default for non-rotated devices (the common phone case).
 */
async function queryDeviceRotation(deviceId) {
  // Preferred: `dumpsys input` reports SurfaceOrientation per display, which
  // tracks the actual on-screen rotation (matches what scrcpy captures).
  const dump = await shellCapture(deviceId, 'dumpsys input');
  const surfMatch = dump.match(/SurfaceOrientation:\s*(\d+)/);
  if (surfMatch) {
    const n = parseInt(surfMatch[1], 10);
    if (n >= 0 && n <= 3) return n;
  }

  // Fallback: user_rotation. Reflects the user-set rotation; usually matches
  // SurfaceOrientation unless the app forces an orientation.
  const setting = (await shellCapture(deviceId, 'settings get system user_rotation')).trim();
  const n = parseInt(setting, 10);
  if (Number.isFinite(n) && n >= 0 && n <= 3) return n;

  return 0;
}

/**
 * Returns the display dimensions in the CURRENT rotation's coordinate space.
 *
 * `wm size` reports the panel's NATURAL-orientation dimensions, but
 * `input tap X Y` injects MotionEvents in the CURRENT-rotation coordinate
 * space (the same one the user sees and that scrcpy captures). When the
 * device is rotated 90° or 270° away from natural — common for tablet AVDs
 * (Pixel Tablet, Pixel C, Nexus 9) that boot landscape from a portrait-natural
 * panel — those two spaces have swapped axes. Taps then land at the wrong
 * point (the iPad-style logical-size mismatch).
 *
 * Phones in their natural portrait orientation (rotation 0) are unaffected.
 */
async function queryDisplaySize(deviceId) {
  const natural = await new Promise((resolve) => {
    const proc = spawn(streamConfig.adbPath, ['-s', deviceId, 'shell', 'wm', 'size']);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => {
      const parsed = parseWmSizeOutput(out);
      resolve(parsed || { width: 1080, height: 1920 });
    });
    proc.on('error', () => resolve({ width: 1080, height: 1920 }));
  });

  const rotation = await queryDeviceRotation(deviceId);
  if (rotation === 1 || rotation === 3) {
    return { width: natural.height, height: natural.width };
  }
  return natural;
}

async function injectInput(deviceId, displaySize, event) {
  if (!deviceId || !event?.action) {
    return { success: false, error: 'Invalid control event' };
  }

  const { width, height } = displaySize;

  try {
    switch (event.action) {
      case 'tap': {
        const x = Math.round(Math.max(0, Math.min(1, event.x)) * width);
        const y = Math.round(Math.max(0, Math.min(1, event.y)) * height);
        await shell(deviceId, `input tap ${x} ${y}`);
        return { success: true, x, y };
      }
      case 'swipe': {
        const x1 = Math.round(Math.max(0, Math.min(1, event.x1)) * width);
        const y1 = Math.round(Math.max(0, Math.min(1, event.y1)) * height);
        const x2 = Math.round(Math.max(0, Math.min(1, event.x2)) * width);
        const y2 = Math.round(Math.max(0, Math.min(1, event.y2)) * height);
        const dur = event.durationMs ?? 150;
        await shell(deviceId, `input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`);
        return { success: true };
      }
      case 'key': {
        const code = String(event.keyCode || '').replace(/^KEYCODE_/, '');
        await shell(deviceId, `input keyevent KEYCODE_${code}`);
        return { success: true };
      }
      case 'text': {
        const escaped = String(event.text || '').replace(/ /g, '%s').replace(/'/g, "\\'");
        await shell(deviceId, `input text '${escaped}'`);
        return { success: true };
      }
      default:
        return { success: false, error: `Unknown action: ${event.action}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { injectInput, queryDisplaySize };
