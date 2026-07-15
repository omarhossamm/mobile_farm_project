/**
 * Low-latency outbound frame delivery.
 *
 * Interactive mirroring needs frames on the wire the moment they are ready.
 * The previous FramePacer queued bursts (screenrecord dumps many frames at
 * once after idle) which added seconds of lag and made the mirror appear to
 * "catch up" through stale frames — visible as overlap/stutter.
 *
 * Contract:
 *   - Every captured frame is sent immediately on submit().
 *   - No FIFO queue, no per-tick drain, no mid-GOP drops.
 *   - Optional idle-fill (disabled by default for screenrecord) can repeat
 *     the last picture when capture goes quiet — useful for startup gaps only.
 */

const { createLogger } = require('../lib/logger');

const logger = createLogger('OUTPUT_PACER');

class OutputPacer {
  /**
   * @param {number} fps — used only for idle-fill tick interval
   * @param {(frame: object) => void} onSend
   * @param {{ idleFill?: boolean, idleRepeatMs?: number }} [options]
   */
  constructor(fps, onSend, options = {}) {
    this._fps = Math.max(1, fps || 20);
    this._onSend = onSend;
    this._idleFill = options.idleFill === true;
    this._idleRepeatMs = options.idleRepeatMs ?? 350;
    this._latest = null;
    this._lastSendAt = 0;
    this._timer = null;
    this._enabled = false;
    this._stats = {
      submitted: 0,
      sent: 0,
      blocked: 0,
      idleRepeats: 0,
      lastDropReason: null
    };
  }

  setEnabled(enabled) {
    this._enabled = !!enabled;
    if (this._enabled) {
      logger.debug('Output pacer enabled', { idleFill: this._idleFill });
    }
  }

  isEnabled() {
    return this._enabled;
  }

  start() {
    if (this._timer) return;
    const intervalMs = Math.max(10, Math.floor(1000 / this._fps));
    this._timer = setInterval(() => this._onIdleTick(), intervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    logger.debug('Output pacer started', {
      fps: this._fps,
      intervalMs,
      idleFill: this._idleFill,
      idleRepeatMs: this._idleRepeatMs
    });
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._enabled = false;
    this._latest = null;
    this._lastSendAt = 0;
  }

  /**
   * Send immediately — no queue.
   *
   * SEMANTICS OF _enabled
   * ──────────────────────
   * _enabled = true  → forward frame AND allow idle-fill repeats on silence.
   * _enabled = false → forward frame BUT suppress idle-fill repeats.
   *
   * Frames are ALWAYS forwarded regardless of _enabled.  The previous
   * implementation dropped frames when disabled, which caused frame freezes
   * whenever _startDecoderWarmup was re-entered during an active stream (e.g.
   * a DTLS re-event calling _tryCompleteStartup with gate already open).
   * Since deliverFrame() already guards on gate.open, the pacer is only
   * submitted real frames that MUST reach the sender.
   */
  submit(frame) {
    if (!frame) return;
    this._stats.submitted++;
    this._latest = frame;
    this._sendNow(frame);
  }

  submitImmediate(frame) {
    this.submit(frame);
  }

  clear() {
    this._latest = null;
  }

  flushNow() {
    /* no-op — nothing is queued */
  }

  get stats() {
    return {
      ...this._stats,
      queueDepth: 0,
      queueDepthPeak: 0,
      queueCap: 0,
      fps: this._fps,
      // 'immediate' always — we never queue/hold frames.
      // idleFill state is reflected by pacerEnabled in the heartbeat.
      mode: 'immediate'
    };
  }

  _sendNow(frame) {
    this._lastSendAt = Date.now();
    this._stats.sent++;
    try {
      this._onSend(frame);
    } catch (err) {
      logger.warn('Output pacer send failed', { error: err.message });
    }
  }

  /** Repeat last frame only when capture has gone quiet (optional). */
  _onIdleTick() {
    if (!this._enabled || !this._idleFill || !this._latest) return;
    const idleMs = Date.now() - this._lastSendAt;
    if (idleMs < this._idleRepeatMs) return;
    this._stats.idleRepeats++;
    this._sendNow(this._latest);
  }
}

module.exports = { OutputPacer };
