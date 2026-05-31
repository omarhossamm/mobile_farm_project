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

function queryDisplaySize(deviceId) {
  return new Promise((resolve) => {
    const proc = spawn(streamConfig.adbPath, ['-s', deviceId, 'shell', 'wm', 'size']);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => {
      const parsed = parseWmSizeOutput(out);
      resolve(parsed || { width: 1080, height: 1920 });
    });
    proc.on('error', () => resolve({ width: 1080, height: 1920 }));
  });
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
