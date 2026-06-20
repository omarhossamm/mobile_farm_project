/**
 * Android input control via a persistent `adb shell` session.
 *
 * Transport: persistent `adb -s DEVICE_ID shell` process per device session.
 * ──────────────────────────────────────────────────────────────────────────
 * The previous implementation called execFileAsync(adb, ['shell', 'input', ...])
 * for every tap/swipe/key.  This spawned a new process, reconnected to the
 * ADB server, opened a new shell session, ran the input command, and exited —
 * adding ~80–150 ms of overhead per event on top of the ~20–40 ms that the
 * Android `input` tool itself takes.
 *
 * This implementation keeps ONE persistent `adb -s DEVICE_ID shell` process
 * alive for the session lifetime and writes commands directly to its stdin:
 *
 *   stdin:  `input tap 540 960\n`
 *   stdout: (not read — input produces no output)
 *
 * Per-event latency:  20–40 ms  (Android `input` execution on device)
 * vs. previous:       100–250 ms (includes process spawn + ADB negotiation)
 *
 * Resilience:
 *   - If the shell process exits (device disconnect, ADB server restart),
 *     it is respawned automatically on the next inject() call.
 *   - A brief drain delay (200 ms) is added after respawn to avoid sending
 *     a command before the shell prompt is ready.
 *   - If respawn fails (device offline), the event is dropped with an error.
 *
 * @module providers/android/control/AdbInputProvider
 */

'use strict';

const { spawn } = require('child_process');
const { PLATFORMS } = require('../../../platform/types');
const { streamConfig } = require('../../../lib/config');
const { createLogger } = require('../../../lib/logger');
const { queryDisplaySize } = require('../../../stream/capture/android/input');

const logger = createLogger('ADB_INPUT');

const RESPAWN_DELAY_MS = 200;
const SPAWN_TIMEOUT_MS = 4000;

// ─── Per-device persistent shell session ──────────────────────────────────────

class PersistentAdbShell {
  constructor(deviceId, adbPath) {
    this._deviceId = deviceId;
    this._adbPath = adbPath;
    this._proc = null;
    this._ready = false;
    this._spawning = false;
    this._dead = false;
  }

  /**
   * Ensure the shell process is alive and ready to accept commands.
   * @returns {Promise<boolean>}  true if ready, false if spawn failed.
   */
  async ensureReady() {
    if (this._ready && this._proc) return true;
    if (this._spawning) {
      // Another call is already spawning — wait for it.
      return new Promise((resolve) => {
        const poll = setInterval(() => {
          if (!this._spawning) {
            clearInterval(poll);
            resolve(this._ready);
          }
        }, 50);
      });
    }
    return this._spawn();
  }

  /**
   * Write a shell command to stdin.  Must call ensureReady() first.
   * @param {string} cmd  e.g. 'input tap 100 200'
   * @returns {boolean}  false if the process is not ready
   */
  write(cmd) {
    if (!this._ready || !this._proc || this._dead) return false;
    try {
      const ok = this._proc.stdin.write(`${cmd}\n`);
      if (!ok) {
        // stdin buffer full — drain before the next write.
        // For control events this is extremely rare; log and continue.
        logger.debug('adb shell stdin buffer full, drain needed', { deviceId: this._deviceId });
      }
      return true;
    } catch (err) {
      logger.debug('adb shell stdin write failed', { deviceId: this._deviceId, error: err.message });
      this._ready = false;
      return false;
    }
  }

  destroy() {
    this._dead = true;
    this._ready = false;
    if (this._proc) {
      try { this._proc.kill('SIGTERM'); } catch {}
      this._proc = null;
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  async _spawn() {
    this._spawning = true;
    this._ready = false;

    if (this._proc) {
      try { this._proc.kill('SIGTERM'); } catch {}
      this._proc = null;
    }

    return new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        this._spawning = false;
        this._ready = value;
        resolve(value);
      };

      try {
        const proc = spawn(this._adbPath, ['-s', this._deviceId, 'shell'], {
          stdio: ['pipe', 'pipe', 'pipe']
        });

        proc.on('error', (err) => {
          logger.warn('adb shell spawn error', { deviceId: this._deviceId, error: err.message });
          this._proc = null;
          settle(false);
        });

        proc.on('close', (code, signal) => {
          if (this._proc === proc) {
            logger.debug('adb shell exited', { deviceId: this._deviceId, code, signal });
            this._proc = null;
            this._ready = false;
          }
        });

        // Discard stdout/stderr — `input` commands produce no useful output.
        proc.stdout.resume();
        proc.stderr.resume();

        this._proc = proc;

        // Give the shell a brief moment to initialize before accepting commands.
        setTimeout(() => settle(true), RESPAWN_DELAY_MS);

        // Hard timeout — if the shell doesn't settle, something is wrong.
        setTimeout(() => {
          if (!settled) {
            logger.warn('adb shell spawn timeout', { deviceId: this._deviceId });
            settle(false);
          }
        }, SPAWN_TIMEOUT_MS);
      } catch (err) {
        logger.warn('adb shell spawn threw', { deviceId: this._deviceId, error: err.message });
        settle(false);
      }
    });
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

class AdbInputProvider {
  constructor() {
    this.providerId = 'adb-input';
    this.platform = PLATFORMS.ANDROID;
    // keyed by sessionId (or deviceId when sessionId is unavailable)
    this._shells = new Map();
    /** @type {Map<string, {width: number, height: number}>} */
    this._displaySizes = new Map();
  }

  supports(handle) {
    return handle.ref.platform === PLATFORMS.ANDROID;
  }

  async inject(handle, event) {
    const deviceId = handle.ref.id;
    const sessionId = handle.sessionId || deviceId;
    const adbPath = streamConfig.adbPath || 'adb';

    const { width: w, height: h } = await this._resolveDisplaySize(deviceId, handle);

    let shell = this._shells.get(sessionId);
    if (!shell) {
      shell = new PersistentAdbShell(deviceId, adbPath);
      this._shells.set(sessionId, shell);
    }

    const ready = await shell.ensureReady();
    if (!ready) {
      return { success: false, error: `adb shell not available for device ${deviceId}` };
    }

    const cmd = this._buildCommand(event, w, h);
    if (!cmd) {
      return { success: false, error: `Unknown action: ${event.action}` };
    }

    const written = shell.write(cmd);
    if (!written) {
      // Shell died between ensureReady and write — try once to respawn.
      const retryReady = await shell.ensureReady();
      if (!retryReady || !shell.write(cmd)) {
        return { success: false, error: `adb shell write failed for device ${deviceId}` };
      }
    }

    return { success: true };
  }

  /**
   * Called by PlatformHost / ControlDispatcher when a session ends.
   * Closes the persistent shell to free the ADB connection.
   */
  closeSession(sessionId) {
    const shell = this._shells.get(sessionId);
    if (shell) {
      shell.destroy();
      this._shells.delete(sessionId);
      logger.debug('adb persistent shell closed', { sessionId });
    }
  }

  async _resolveDisplaySize(deviceId, handle) {
    const md = handle?.ref?.metadata || {};
    const fromMeta = md.display_width || md.screen_width || md.logical_width;
    const fromMetaH = md.display_height || md.screen_height || md.logical_height;
    if (fromMeta > 0 && fromMetaH > 0) {
      return { width: fromMeta, height: fromMetaH };
    }

    if (this._displaySizes.has(deviceId)) {
      return this._displaySizes.get(deviceId);
    }

    const size = await queryDisplaySize(deviceId);
    this._displaySizes.set(deviceId, size);
    logger.info('Android display size resolved for touch', { deviceId, ...size });
    return size;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  _buildCommand(event, w, h) {
    switch (event.action) {
      case 'tap': {
        const x = toPixel(event.x, w);
        const y = toPixel(event.y, h);
        return `input tap ${x} ${y}`;
      }
      case 'swipe': {
        const x1 = toPixel(event.x1 ?? event.x, w);
        const y1 = toPixel(event.y1 ?? event.y, h);
        const x2 = toPixel(event.x2, w);
        const y2 = toPixel(event.y2, h);
        const dur = event.durationMs ?? 300;
        return `input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`;
      }
      case 'key': {
        const keyCode = (event.keyCode || '').replace(/^KEYCODE_/, '');
        return `input keyevent ${keyCode}`;
      }
      case 'text': {
        const text = encodeAdbInputText(event.text || '');
        return `input text '${text.replace(/'/g, "'\\''")}'`;
      }
      default:
        return null;
    }
  }
}

function toPixel(norm, dimension) {
  return Math.round(Math.max(0, Math.min(1, norm)) * dimension);
}

/** adb `input text` encoding: spaces and percent signs need escaping. */
function encodeAdbInputText(text) {
  return text.replace(/%/g, '%%').replace(/ /g, '%s');
}

module.exports = { AdbInputProvider };
