'use strict';

/**
 * iOS control via idb HID (`idb ui ...`).
 *
 * Touch coordinates arrive normalized [0,1] in DEVICE space (the client has
 * already removed letterbox and applied rotation). We convert to device POINTS
 * using the authoritative CaptureGeometry math — the same module the client and
 * server geometry tests share — so there are no duplicate mappers or magic
 * offsets. idb HID operates in points.
 *
 * @module providers/ios/control/IdbHidControlProvider
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const { PLATFORMS } = require('../../../platform/types');
const { streamConfig } = require('../../../lib/config');
const { createLogger } = require('../../../lib/logger');
const { resolveDeviceGeometry } = require('../../../config/iosDeviceSizes');
const { normalizedToDevicePoints } = require('../../../stream/core/captureGeometry');

const execFileAsync = promisify(execFile);
const logger = createLogger('IOS_HID');

// Client keyCode → idb hardware button.
const BUTTON_MAP = {
  KEYCODE_HOME: 'HOME',
  HOME: 'HOME',
  KEYCODE_POWER: 'LOCK',
  LOCK: 'LOCK',
  KEYCODE_LOCK: 'LOCK',
  SIRI: 'SIRI',
  KEYCODE_ASSIST: 'SIRI',
  SIDE_BUTTON: 'SIDE_BUTTON',
  APPLE_PAY: 'APPLE_PAY'
};

// USB HID usage codes for editing keys (idb `ui key <code>`).
const HID_KEY_MAP = {
  KEYCODE_ENTER: '40',
  KEYCODE_DEL: '42',
  KEYCODE_FORWARD_DEL: '76',
  KEYCODE_TAB: '43'
};

class IdbHidControlProvider {
  constructor() {
    this.providerId = 'ios-idb-hid';
    this.platform = PLATFORMS.IOS;
  }

  supports(handle) {
    return handle.ref.platform === PLATFORMS.IOS;
  }

  _deviceLogical(handle) {
    const md = handle.ref.metadata || {};
    if (md.logical_width > 0 && md.logical_height > 0) {
      return { w: md.logical_width, h: md.logical_height };
    }
    const { logical } = resolveDeviceGeometry(
      md.deviceTypeIdentifier || handle.ref.deviceTypeIdentifier || '', null
    );
    return logical;
  }

  async inject(handle, event) {
    const udid = handle.ref.id;

    // Home-indicator swipes are SpringBoard system gestures; idb HID swipes
    // never reach that recognizer. The viewer maps them client-side to:
    //   home         → single HOME press
    //   appSwitcher  → double HOME press (App Switcher on Face ID simulators)
    if (event.action === 'home') {
      return this._pressButtonTimes(udid, 'HOME', 1);
    }
    if (event.action === 'appSwitcher') {
      return this._pressButtonTimes(udid, 'HOME', 2);
    }

    const logical = this._deviceLogical(handle);
    const args = this._buildArgs(udid, event, logical);
    if (!args) {
      return { success: false, error: `Unsupported iOS action: ${event.action}` };
    }
    try {
      await execFileAsync(streamConfig.idbPath, args, { timeout: 5000 });
      return { success: true };
    } catch (err) {
      logger.warn('idb ui command failed', { udid, action: event.action, error: err.message });
      return { success: false, error: err.message };
    }
  }

  async _pressButtonTimes(udid, button, times) {
    try {
      for (let i = 0; i < times; i++) {
        await execFileAsync(streamConfig.idbPath, ['ui', 'button', button, '--udid', udid], { timeout: 5000 });
      }
      return { success: true };
    } catch (err) {
      logger.warn('idb button press failed', { udid, button, times, error: err.message });
      return { success: false, error: err.message };
    }
  }

  closeSession() { /* idb has no per-session persistent resource here */ }

  _buildArgs(udid, event, logical) {
    // idb CLI grammar: `idb ui <subcommand> <positionals> [--options] --udid X`.
    // The --udid flag is parsed by the subcommand, so it MUST come AFTER the
    // subcommand and its positional args — not between `ui` and the subcommand.
    const tail = ['--udid', udid];
    switch (event.action) {
      case 'tap': {
        const p = normalizedToDevicePoints(event.x, event.y, logical);
        return ['ui', 'tap', round(p.x), round(p.y), ...tail];
      }
      case 'swipe': {
        const p1 = normalizedToDevicePoints(event.x1 ?? event.x, event.y1 ?? event.y, logical);
        const p2 = normalizedToDevicePoints(event.x2, event.y2, logical);
        const durSec = ((event.durationMs ?? 300) / 1000).toFixed(2);
        return ['ui', 'swipe', round(p1.x), round(p1.y), round(p2.x), round(p2.y), '--duration', durSec, ...tail];
      }
      case 'text':
        return ['ui', 'text', event.text || '', ...tail];
      case 'key': {
        const code = (event.keyCode || '').toUpperCase();
        const btn = BUTTON_MAP[code];
        if (btn) return ['ui', 'button', btn, ...tail];
        const hid = HID_KEY_MAP[code];
        if (hid) return ['ui', 'key', hid, ...tail];
        if (event.hidKey != null) return ['ui', 'key', String(event.hidKey), ...tail];
        return null;
      }
      default:
        return null;
    }
  }
}

function round(v) { return String(Math.round(v)); }

module.exports = { IdbHidControlProvider };
