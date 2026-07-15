/**
 * Continuous H.264 from `adb exec-out screenrecord`.
 *
 * Lifecycle policy (per session contract):
 *   - `start()` spawns the `adb screenrecord` process exactly once.
 *   - The process is NEVER respawned during the session. Any exit — clean
 *     time-limit expiry, crash, device disconnect, or stall — is surfaced
 *     via an `'ended'` event and the session is considered dead.
 *   - The upstream StreamManager translates `'ended'` into a full WebRTC
 *     teardown + `stream_error` to the desktop client.
 *
 * Production features:
 *   - Stall / disconnect watchdog — destroys the stream if the device goes
 *     silent for more than ANDROID_STALL_TIMEOUT_MS milliseconds.
 *   - IDR / GOP tracker — scans each chunk for IDR NAL units to measure the
 *     real keyframe interval and warns if it exceeds ANDROID_GOP_WARN_MS.
 *   - Clean on-device cleanup — `stop()` and the stall watchdog both run
 *     `adb shell pkill -INT screenrecord` to kill orphaned processes on the
 *     device, preventing battery drain and USB bandwidth leaks.
 */

'use strict';

const { EventEmitter } = require('events');
const { spawn }        = require('child_process');
const { streamConfig, parseIntEnv } = require('../../lib/config');
const { createLogger } = require('../../lib/logger');
const { injectInput, queryDisplaySize } = require('./android/input');

const logger = createLogger('SCREENRECORD');

// ─── Tunables ─────────────────────────────────────────────────────────────────

/**
 * Silence-detection threshold (ms).
 *
 * If the adb process remains alive but its stdout produces 0 bytes for longer
 * than this window, the device is presumed stalled or physically disconnected.
 * The process is destroyed and a `device_stalled` event is emitted upstream.
 *
 * 6000 ms (6 s) — Android emulators stop emitting frames when the screen is
 * completely idle/static (MediaCodec skips unchanged frames to save bandwidth).
 * A tight timeout (2.5 s) incorrectly fires during normal idle periods.
 * 6 s comfortably covers the worst-case "static screen" gap while still
 * catching real device disconnects promptly.  Physical devices tend to produce
 * at least one IDR or P-frame every 2 s regardless of screen content, so they
 * are not affected by the higher threshold.
 *
 * Override: ANDROID_STALL_TIMEOUT_MS
 */
const STALL_TIMEOUT_MS = parseIntEnv('ANDROID_STALL_TIMEOUT_MS', 6000);

/**
 * Maximum expected IDR keyframe interval (ms) before a warning is logged.
 *
 * AOSP's `screenrecord` instructs MediaCodec to emit an I-frame every 2 s
 * (i.e. every 60 frames at 30 fps).  If no IDR arrives within this window
 * while data IS flowing, a warning is written to the log.
 *
 * Important: standard `adb screenrecord` exposes no `--keyframe-interval`
 * flag; the GOP is controlled solely by the device's MediaCodec encoder.
 * The default 2 s GOP is guaranteed across all AOSP versions from API 21+.
 * We cannot force IDR frames from outside the `screenrecord` process, so
 * this watchdog is diagnostic-only (it never tears down the stream alone).
 * The stall watchdog (STALL_TIMEOUT_MS) handles the case where data stops.
 *
 * Override: ANDROID_GOP_WARN_MS
 */
const GOP_WARN_MS = parseIntEnv('ANDROID_GOP_WARN_MS', 4000);

// ─── Lightweight IDR detector ─────────────────────────────────────────────────

// Annex-B start codes (pre-allocated, never reallocated)
const _SC4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const _SC3 = Buffer.from([0x00, 0x00, 0x01]);

/**
 * Returns true if `chunk` contains an IDR NAL unit (H.264 type 5) within the
 * first `scanLimit` bytes.
 *
 * adb exec-out delivers MediaCodec output aligned to NAL boundaries, so IDR
 * frames always start within the first few bytes of a new chunk.  Scanning
 * only a small prefix keeps this function O(1) relative to chunk size.
 */
function chunkContainsIdr(chunk, scanLimit = 128) {
  const cap = Math.min(chunk.length, scanLimit);
  let pos = 0;
  while (pos < cap) {
    // Prefer 4-byte start code over 3-byte to avoid false positives.
    let hit = chunk.indexOf(_SC4, pos);
    let scLen = 4;
    const hit3 = chunk.indexOf(_SC3, pos);
    if (hit3 !== -1 && (hit === -1 || hit3 < hit)) {
      // Only use the 3-byte match if it isn't the interior of a 4-byte one.
      if (hit3 === 0 || chunk[hit3 - 1] !== 0x00) {
        hit = hit3; scLen = 3;
      }
    }
    if (hit === -1 || hit + scLen >= cap) break;
    const nalType = chunk[hit + scLen] & 0x1f;
    if (nalType === 5) return true; // IDR slice
    pos = hit + scLen + 1;
  }
  return false;
}

// ─── ScreenrecordCapture ──────────────────────────────────────────────────────

class ScreenrecordCapture extends EventEmitter {
  /**
   * @param {string} deviceId  ADB serial / transport ID
   * @param {object} [options]
   */
  constructor(deviceId, options = {}) {
    super();
    this.deviceId   = deviceId;
    // Expose providerId so StreamManager heartbeat / logs can identify this
    // capture without special-casing ScreenrecordCapture by class name.
    this.providerId = 'adb-screenrecord';

    // Resolution and bitrate resolution order (highest-priority first):
    //   1. Explicit call-site options  (e.g. from StreamManager per-session opts)
    //   2. ANDROID_STREAM_WIDTH/HEIGHT/BITRATE env vars  (strictly parsed integers)
    //   3. Global streamConfig fallbacks  (STREAM_WIDTH / STREAM_RECORD_BITRATE)
    //
    // Env-var values are read here — not at module load — so that tests and
    // integration harnesses can override them per-process without restarting.
    const envWidth   = parseIntEnv('ANDROID_STREAM_WIDTH',   0);
    const envHeight  = parseIntEnv('ANDROID_STREAM_HEIGHT',  0);
    const envBitrate = parseIntEnv('ANDROID_STREAM_BITRATE', 0);

    this.width        = options.width   || (envWidth   > 0 ? envWidth   : streamConfig.androidWidth)   || streamConfig.width;
    this.height       = options.height  || (envHeight  > 0 ? envHeight  : streamConfig.androidHeight)  || streamConfig.height;
    this.bitRate      = options.bitRate || (envBitrate > 0 ? envBitrate : streamConfig.androidBitrate) || streamConfig.recordBitrate;
    this.timeLimitSec = options.timeLimitSec || streamConfig.screenrecordTimeLimit;

    this._proc         = null;
    this._running      = false;
    this._spawned      = false;
    this._ended        = false;
    this._displaySize  = null;

    // Watchdog timers
    this._stallTimer   = null;
    this._gopTimer     = null;
    this._lastIdrAt    = 0;

    this._stats = {
      bytes:     0,
      chunks:    0,
      idrFrames: 0,
      startedAt: null,
      endedAt:   null,
      endReason: null
    };
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async start() {
    if (this._spawned) {
      // Single-shot contract: a second start() is a programming error.
      return { success: this._running, error: this._running ? null : 'Capture already terminated' };
    }
    this._displaySize = await queryDisplaySize(this.deviceId);
    this._running     = true;
    this._spawned     = true;
    this._stats.startedAt = new Date().toISOString();

    this._spawn();

    logger.info('Screenrecord capture started', {
      deviceId:      this.deviceId,
      size:          `${this.width}x${this.height}`,
      bitRate:       this.bitRate,
      timeLimitSec:  this.timeLimitSec,
      stallTimeoutMs: STALL_TIMEOUT_MS,
      gopWarnMs:     GOP_WARN_MS
    });
    return { success: true };
  }

  /**
   * Graceful stop — called by StreamManager on session teardown.
   *
   * Sends SIGINT to the local adb proxy (prompts adb to exit cleanly), then
   * follows up with SIGKILL after a short grace period.  Concurrently runs
   * `adb shell pkill -INT screenrecord` to kill the on-device process so it
   * doesn't keep recording and draining the device's battery / CPU after the
   * desktop session ends.
   */
  stop() {
    if (!this._running && !this._proc) return;
    this._running = false;
    this._clearTimers();

    const proc  = this._proc;
    this._proc  = null;

    if (proc) {
      // SIGINT gives the adb proxy a chance to propagate EOF to the device.
      try { proc.kill('SIGINT'); } catch {}
      // Hard-kill after 500 ms in case adb stalls during teardown.
      const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 500);
      if (typeof t.unref === 'function') t.unref();
    }

    // Kill any still-running screenrecord process on the device itself.
    this._killOnDeviceScreenrecord();

    logger.info('Screenrecord capture stopped', { deviceId: this.deviceId, stats: this._stats });
  }

  async injectInput(event) {
    const size = this._displaySize || { width: this.width, height: this.height };
    return injectInput(this.deviceId, size, event);
  }

  getStatus() {
    return {
      mode:       'adb_screenrecord',
      deviceId:   this.deviceId,
      resolution: `${this.width}x${this.height}`,
      running:    this._running,
      stats:      { ...this._stats }
    };
  }

  // ── Internal: process spawn ──────────────────────────────────────────────────

  _spawn() {
    // All three tunable values (width, height, bitRate) are resolved once in
    // the constructor from env vars → streamConfig → defaults.  They are passed
    // verbatim here so that the spawned command exactly reflects what was logged
    // at capture start and what the caller can inspect via getStatus().
    const args = [
      '-s',        this.deviceId,
      'exec-out',
      'screenrecord',
      '--output-format=h264',
      `--size=${this.width}x${this.height}`,
      `--bit-rate=${this.bitRate}`,
      `--time-limit=${this.timeLimitSec}`,
      '-'
    ];

    logger.info('Spawning screenrecord', {
      deviceId: this.deviceId,
      cmd:      `${streamConfig.adbPath} ${args.join(' ')}`
    });

    this._proc = spawn(streamConfig.adbPath, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Arm the stall watchdog immediately — fires if no data arrives at all.
    this._resetStallTimer();

    // ── stdout: data + watchdog reset + IDR tracking ─────────────────────────
    this._proc.stdout.on('data', (chunk) => {
      if (!this._running) return;

      this._stats.bytes  += chunk.length;
      this._stats.chunks += 1;

      // Each data event resets the stall watchdog.
      this._resetStallTimer();

      // Lightweight IDR scan — keeps GOP metrics without a full NAL parser.
      if (chunkContainsIdr(chunk)) {
        this._lastIdrAt = Date.now();
        this._stats.idrFrames++;
        this._resetGopTimer();
      }

      this.emit('data', chunk);
    });

    // ── stderr: log everything from the device ───────────────────────────────
    let stderrBuf = '';
    this._proc.stderr.on('data', (d) => {
      if (stderrBuf.length < 1000) stderrBuf += d.toString();
    });

    // ── Process events ───────────────────────────────────────────────────────
    this._proc.on('error', (err) => {
      this._clearTimers();
      if (this._running) this._reportEnd('spawn_error', { error: err.message });
    });

    this._proc.on('close', (code, signal) => {
      this._clearTimers();
      this._proc = null;
      if (!this._running) return; // stop() was called — silent teardown.

      const stderrSnippet = stderrBuf.slice(0, 500);
      const reason = code === 0
        ? 'time_limit'
        : signal ? `signal_${signal}` : `exit_code_${code}`;

      logger.warn('screenrecord exited', {
        deviceId:  this.deviceId,
        code, signal, reason,
        idrFrames: this._stats.idrFrames,
        bytes:     this._stats.bytes,
        stderr:    stderrSnippet
      });
      this._reportEnd(reason, { code, signal, stderr: stderrSnippet });
    });
  }

  // ── Internal: stall watchdog ─────────────────────────────────────────────────

  _resetStallTimer() {
    this._clearStallTimer();
    if (!this._running) return;
    this._stallTimer = setTimeout(() => {
      this._stallTimer = null;
      if (!this._running) return;
      logger.warn('Android device stall detected — no stdout data', {
        deviceId:  this.deviceId,
        stallMs:   STALL_TIMEOUT_MS,
        bytesTotal: this._stats.bytes
      });
      this._forceStop('device_stalled');
    }, STALL_TIMEOUT_MS);
    if (typeof this._stallTimer.unref === 'function') this._stallTimer.unref();
  }

  _clearStallTimer() {
    if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null; }
  }

  // ── Internal: GOP / keyframe watchdog ────────────────────────────────────────

  _resetGopTimer() {
    this._clearGopTimer();
    if (!this._running) return;
    this._gopTimer = setTimeout(() => {
      this._gopTimer = null;
      if (!this._running) return;
      logger.warn('No IDR/keyframe within GOP warn window — possible encoder stall', {
        deviceId:   this.deviceId,
        gapMs:      Date.now() - this._lastIdrAt,
        thresholdMs: GOP_WARN_MS,
        idrTotal:   this._stats.idrFrames
      });
      // Diagnostic only — cannot force an IDR in standard adb screenrecord.
      // The stall watchdog (STALL_TIMEOUT_MS) will tear down the stream if
      // data stops arriving entirely.
    }, GOP_WARN_MS);
    if (typeof this._gopTimer.unref === 'function') this._gopTimer.unref();
  }

  _clearGopTimer() {
    if (this._gopTimer) { clearTimeout(this._gopTimer); this._gopTimer = null; }
  }

  _clearTimers() {
    this._clearStallTimer();
    this._clearGopTimer();
  }

  // ── Internal: forced teardown (stall watchdog) ───────────────────────────────

  /**
   * Destroys the local adb process immediately and arranges for the on-device
   * screenrecord to be killed.  Called only from the stall watchdog.
   */
  _forceStop(reason) {
    const proc = this._proc;
    this._proc = null;

    if (proc) {
      try { proc.kill('SIGKILL'); } catch {}
    }

    // Best-effort cleanup of the on-device process.
    this._killOnDeviceScreenrecord();

    this._reportEnd(reason);
  }

  // ── Internal: on-device process cleanup ─────────────────────────────────────

  /**
   * Sends SIGINT to the on-device `screenrecord` process so it can flush its
   * write buffer and exit cleanly (Android guarantees a clean MP4/H264 finalise
   * on SIGINT).  After 1 s a follow-up SIGKILL is sent for any stragglers.
   *
   * Both commands are spawned detached + unref'd so they never block the
   * Node.js event loop or keep the parent process alive.
   */
  _killOnDeviceScreenrecord() {
    const adb = streamConfig.adbPath;
    const id  = this.deviceId;

    // Graceful: SIGINT lets screenrecord flush and exit.
    const graceful = spawn(adb, ['-s', id, 'shell', 'pkill', '-INT', 'screenrecord'], {
      stdio:    'ignore',
      detached: true
    });
    graceful.unref();

    // Hard kill after 1 s for stragglers that ignore SIGINT.
    const t = setTimeout(() => {
      const force = spawn(adb, ['-s', id, 'shell', 'pkill', '-KILL', 'screenrecord'], {
        stdio:    'ignore',
        detached: true
      });
      force.unref();
    }, 1000);
    if (typeof t.unref === 'function') t.unref();
  }

  // ── Internal: end reporting ──────────────────────────────────────────────────

  _reportEnd(reason, details = {}) {
    if (this._ended) return;
    this._ended   = true;
    this._running = false;
    this._stats.endedAt   = new Date().toISOString();
    this._stats.endReason = reason;
    this.emit('ended', { reason, ...details });
  }
}

module.exports = { ScreenrecordCapture };
