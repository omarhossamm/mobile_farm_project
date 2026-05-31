/**
 * Continuous H.264 from `adb exec-out screenrecord`.
 *
 * Lifecycle policy (per session contract):
 *   - `start()` spawns the `adb screenrecord` process exactly once.
 *   - The process is NEVER respawned during the session. Any exit — clean
 *     time-limit expiry, crash, device disconnect, or stderr fatal — is
 *     surfaced via an `'ended'` event and the session is considered dead.
 *   - The upstream StreamManager translates `'ended'` into a full WebRTC
 *     teardown + `stream_error` to the desktop client, which is expected to
 *     reconnect with a fresh session id. No partial media-pipeline restart
 *     is performed anywhere.
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { streamConfig } = require('../../lib/config');
const { createLogger } = require('../../lib/logger');
const { injectInput, queryDisplaySize } = require('./android/input');

const logger = createLogger('SCREENRECORD');

class ScreenrecordCapture extends EventEmitter {
  /**
   * @param {string} deviceId
   * @param {object} [options]
   */
  constructor(deviceId, options = {}) {
    super();
    this.deviceId = deviceId;
    this.width = options.width || streamConfig.width;
    this.height = options.height || streamConfig.height;
    this.bitRate = options.bitRate || streamConfig.recordBitrate;
    this.timeLimitSec = options.timeLimitSec || streamConfig.screenrecordTimeLimit;
    this._proc = null;
    this._running = false;
    this._spawned = false;
    this._ended = false;
    this._displaySize = null;
    this._stats = {
      bytes: 0,
      chunks: 0,
      restarts: 0,
      startedAt: null,
      endedAt: null,
      endReason: null
    };
  }

  async start() {
    if (this._spawned) {
      // Single-shot contract: a second start() is a programming error, never
      // an actual respawn. Return success if still running, error otherwise.
      return { success: this._running, error: this._running ? null : 'Capture already terminated' };
    }
    this._displaySize = await queryDisplaySize(this.deviceId);
    this._running = true;
    this._spawned = true;
    this._stats.startedAt = new Date().toISOString();
    this._spawn();
    logger.info('Screenrecord capture started (single-shot, no auto-restart)', {
      deviceId: this.deviceId,
      size: `${this.width}x${this.height}`,
      bitRate: this.bitRate,
      timeLimitSec: this.timeLimitSec
    });
    return { success: true };
  }

  _spawn() {
    const args = [
      '-s',
      this.deviceId,
      'exec-out',
      'screenrecord',
      '--output-format=h264',
      `--size=${this.width}x${this.height}`,
      `--bit-rate=${this.bitRate}`,
      `--time-limit=${this.timeLimitSec}`,
      '-'
    ];

    this._proc = spawn(streamConfig.adbPath, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this._proc.stdout.on('data', (chunk) => {
      this._stats.bytes += chunk.length;
      this._stats.chunks++;
      this.emit('data', chunk);
    });

    let stderr = '';
    this._proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    this._proc.on('error', (err) => {
      if (this._running) this._reportEnd('spawn_error', { error: err.message });
    });

    this._proc.on('close', (code, signal) => {
      this._proc = null;
      if (!this._running) return; // stop() was called — silent teardown.

      const stderrSnippet = stderr.slice(0, 500);
      const reason = code === 0 ? 'time_limit' : (signal ? `signal_${signal}` : `exit_code_${code}`);
      logger.warn('screenrecord exited — single-shot mode, NOT respawning', {
        deviceId: this.deviceId,
        code,
        signal,
        reason,
        stderr: stderrSnippet
      });
      this._reportEnd(reason, { code, signal, stderr: stderrSnippet });
    });
  }

  /**
   * Mark the capture as ended (single-shot policy) and signal upstream.
   * Idempotent — safe to call from both `error` and `close` handlers.
   */
  _reportEnd(reason, details = {}) {
    if (this._ended) return;
    this._ended = true;
    this._running = false;
    this._stats.endedAt = new Date().toISOString();
    this._stats.endReason = reason;
    this.emit('ended', { reason, ...details });
  }

  async injectInput(event) {
    const size = this._displaySize || { width: this.width, height: this.height };
    return injectInput(this.deviceId, size, event);
  }

  getStatus() {
    return {
      mode: 'adb_screenrecord',
      deviceId: this.deviceId,
      resolution: `${this.width}x${this.height}`,
      running: this._running,
      stats: { ...this._stats }
    };
  }

  stop() {
    if (!this._running && !this._proc) return;
    this._running = false;
    if (this._proc) {
      try {
        this._proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      this._proc = null;
    }
    logger.info('Screenrecord capture stopped', { deviceId: this.deviceId, stats: this._stats });
  }
}

module.exports = { ScreenrecordCapture };
