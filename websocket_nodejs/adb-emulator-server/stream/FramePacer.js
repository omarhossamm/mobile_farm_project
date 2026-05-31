/**
 * Burst-tolerant, GOP-safe video frame pacer.
 *
 * Why this exists
 * ---------------
 * The screenrecord-over-ADB capture is profoundly bursty: during static
 * scenes the encoder emits nothing for seconds at a time, then catches up
 * by dumping ten or twenty frames in a single ~10 ms burst. A naive
 * one-frame-per-tick pacer cannot drain those bursts before the next one
 * arrives, the queue overflows, and dropping ANY single frame from the
 * queue breaks every subsequent P-frame in the same GOP. Android
 * screenrecord does not re-emit IDRs on demand, so a single GOP-breaking
 * drop corrupts the stream until the user restarts the session.
 *
 * Design contract
 * ---------------
 *   - Never drop an inter-coded P-frame to make room. Doing so breaks the
 *     receiver's GOP chain and there is no recovery path (no IDR-on-demand
 *     for screenrecord). This is the strongest invariant in the file.
 *   - Always catch up: when the queue grows, drain more than one frame per
 *     tick so we converge back to depth=0 within a few ticks. A 20-frame
 *     burst empties in ~5 ticks (250 ms) rather than the 1000 ms it would
 *     take a one-per-tick drain.
 *   - On extreme overflow (configurable hard ceiling), drop **only at the
 *     last IDR boundary in the queue**, never mid-GOP. If there is no IDR
 *     in the queue we keep the bytes and log a warning — adding latency is
 *     strictly better than breaking decode.
 *
 * Tuning
 * ------
 *   STREAM_PACER_QUEUE_CAP   default 60   (2 s at 30 fps — see latency note)
 *   STREAM_PACER_CATCHUP_DIV default 2    (drain ceil(depth/div) per tick)
 *   STREAM_PACER_FPS         overrides constructor fps if set
 *
 * Latency note
 * ------------
 * Each queued frame is one tick of pacer delay (≈ 1/fps ms). On top of the
 * unavoidable ~80–120 ms screenrecord/MediaCodec encoder latency, the pacer
 * is the largest knob we control. Keep the queue cap low and the catch-up
 * divisor aggressive — a previously-shipped 300-frame cap with divisor 4
 * could accumulate 15 s of buffered video during long bursts, which surfaces
 * as visible "tap-lands-behind" on the receiver. The current defaults
 * (60 / 2) cap tap-to-pixel latency at roughly 250–400 ms under realistic
 * screenrecord burst patterns.
 *
 * Stats surfaced for the heartbeat
 * --------------------------------
 *   submitted, sent, droppedAtIdr, queueDepth, queueDepthPeak,
 *   maxDrainPerTick, lastDropReason
 */

const { createLogger } = require('../lib/logger');

const logger = createLogger('FRAME_PACER');

const DEFAULT_QUEUE_CAP = parseInt(process.env.STREAM_PACER_QUEUE_CAP, 10) || 60;
const DEFAULT_CATCHUP_DIVISOR = parseInt(process.env.STREAM_PACER_CATCHUP_DIV, 10) || 2;
const FPS_OVERRIDE = parseInt(process.env.STREAM_PACER_FPS, 10) || 0;

class FramePacer {
  /**
   * @param {number} fps
   * @param {(frame: object) => void} onTick
   * @param {object} [opts]
   * @param {number} [opts.queueCap]
   * @param {number} [opts.catchupDivisor]
   */
  constructor(fps, onTick, opts = {}) {
    this._fps = Math.max(1, FPS_OVERRIDE || fps || 20);
    this._onTick = onTick;
    this._queue = [];
    this._queueCap = Math.max(8, opts.queueCap || DEFAULT_QUEUE_CAP);
    this._catchupDiv = Math.max(1, opts.catchupDivisor || DEFAULT_CATCHUP_DIVISOR);
    this._timer = null;
    this._enabled = false;
    this._stats = {
      submitted: 0,
      sent: 0,
      droppedAtIdr: 0,
      droppedNoIdrFallback: 0,
      blocked: 0,
      queueDepthPeak: 0,
      maxDrainPerTick: 0,
      lastDropReason: null
    };
  }

  setEnabled(enabled) {
    this._enabled = !!enabled;
    if (this._enabled) {
      logger.debug('Frame pacer enabled', {
        fps: this._fps,
        queueCap: this._queueCap,
        catchupDivisor: this._catchupDiv
      });
      this._flush();
    }
  }

  isEnabled() {
    return this._enabled;
  }

  start() {
    if (this._timer) return;
    const intervalMs = Math.max(10, Math.floor(1000 / this._fps));
    this._timer = setInterval(() => this._flush(), intervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    logger.debug('Frame pacer timer started', {
      fps: this._fps,
      intervalMs,
      queueCap: this._queueCap,
      catchupDivisor: this._catchupDiv,
      enabled: this._enabled
    });
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._enabled = false;
    this._queue = [];
  }

  /**
   * Submit a frame for paced delivery.
   *
   * INVARIANT: never drops an inter-coded frame. If the queue exceeds the
   * hard cap we look for the most recent IDR in the queue and drop everything
   * before it (clean GOP reset). If no IDR is in the queue we keep all
   * frames and log a warning — added latency is strictly better than
   * GOP-breaking corruption.
   */
  submit(frame) {
    if (!frame) return;
    this._stats.submitted++;
    if (!this._enabled) {
      this._stats.blocked++;
      this._stats.lastDropReason = 'pacer_disabled';
      return;
    }

    this._queue.push(frame);
    if (this._queue.length > this._stats.queueDepthPeak) {
      this._stats.queueDepthPeak = this._queue.length;
    }

    if (this._queue.length > this._queueCap) {
      this._trimQueueAtIdr();
    }
  }

  /**
   * Bypass the pacer queue entirely (used by the STAP-A bootstrap path).
   */
  submitImmediate(frame) {
    if (!frame) return;
    this._stats.submitted++;
    if (!this._enabled) {
      this._stats.blocked++;
      this._stats.lastDropReason = 'pacer_disabled';
      return;
    }
    try {
      this._stats.sent++;
      this._onTick(frame);
    } catch (err) {
      logger.warn('Pacer immediate tick failed', { error: err.message });
    }
  }

  clear() {
    if (this._queue.length > 0) {
      this._stats.droppedAtIdr += this._queue.length;
      this._stats.lastDropReason = 'cleared';
      this._queue = [];
    }
  }

  flushNow() {
    this._flush();
  }

  get stats() {
    return {
      ...this._stats,
      queueDepth: this._queue.length,
      queueCap: this._queueCap,
      fps: this._fps
    };
  }

  /**
   * Compute how many frames to drain in this tick. The goal is to converge
   * back to depth=0 within ~`catchupDiv` ticks for any burst size while
   * keeping steady-state output at 1/tick.
   */
  _drainCount() {
    const depth = this._queue.length;
    if (depth <= 1) return depth;
    return Math.min(depth, Math.max(1, Math.ceil(depth / this._catchupDiv)));
  }

  /**
   * Hard-cap overflow recovery.
   *
   * Preferred path: trim the prefix that ends at the most recent IDR boundary
   *   — a clean GOP reset, decoder picks up cleanly.
   *
   * Fallback path: Android `screenrecord` only emits ONE IDR per session,
   *   so most overflow events have no IDR in the queue. We cannot keep
   *   buffering forever (each extra queued frame is 1/fps ms of tap
   *   latency, so a stuck buffer is exactly the "tap lands behind" symptom
   *   the user reports). In that case we drop a SINGLE oldest P-frame and
   *   accept localized macroblock corruption that will heal at the next
   *   STAP-A param-set refresh or session-level reconnect. Latency
   *   recovery is non-negotiable for an interactive mirror.
   */
  _trimQueueAtIdr() {
    let lastIdr = -1;
    for (let i = this._queue.length - 1; i >= 0; i--) {
      if (this._queue[i].isKeyframe) { lastIdr = i; break; }
    }

    if (lastIdr > 0) {
      const dropped = lastIdr;
      this._queue.splice(0, dropped);
      this._stats.droppedAtIdr += dropped;
      this._stats.lastDropReason = 'trimmed_at_idr';
      logger.warn('Pacer queue past hard cap — trimmed to last IDR (safe GOP reset)', {
        droppedFrames: dropped,
        remaining: this._queue.length,
        queueCap: this._queueCap
      });
      return;
    }

    // No IDR available. Drop a single oldest P-frame — corruption is brief
    // and local; buffering would be unbounded and would surface as tap lag.
    const stale = this._queue.shift();
    this._stats.droppedNoIdrFallback = (this._stats.droppedNoIdrFallback || 0) + 1;
    this._stats.lastDropReason = 'over_cap_dropped_oldest_p';
    if (this._stats.droppedNoIdrFallback === 1
        || this._stats.droppedNoIdrFallback % 30 === 0) {
      // Throttle: once at first occurrence, then every 30th. Otherwise
      // the log fills up during sustained encoder bursts.
      logger.warn('Pacer queue past hard cap, no IDR available — dropping oldest P-frame to bound latency', {
        depth: this._queue.length,
        queueCap: this._queueCap,
        droppedFrameTs: stale && stale.timestamp,
        totalDropped: this._stats.droppedNoIdrFallback
      });
    }
  }

  _flush() {
    if (!this._enabled || this._queue.length === 0) return;
    const n = this._drainCount();
    if (n > this._stats.maxDrainPerTick) this._stats.maxDrainPerTick = n;
    for (let i = 0; i < n; i++) {
      const frame = this._queue.shift();
      if (!frame) break;
      this._stats.sent++;
      try {
        this._onTick(frame);
      } catch (err) {
        logger.warn('Pacer tick failed', { error: err.message });
      }
    }
  }
}

module.exports = { FramePacer };
