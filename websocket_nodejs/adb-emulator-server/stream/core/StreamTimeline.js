/**
 * Structured observability timeline for a streaming session.
 * Emits uniform [STREAM_TIMELINE] log lines for cross-layer correlation.
 *
 * @module stream/core/StreamTimeline
 */

'use strict';

const { createLogger } = require('../../lib/logger');

const logger = createLogger('STREAM_TIMELINE');

class StreamTimeline {
  /**
   * @param {string} sessionId
   */
  constructor(sessionId) {
    this.sessionId = sessionId;
    this._t0 = Date.now();
    this._seq = 0;
    this._events = new Map();
  }

  /**
   * @param {string} event
   * @param {object} [data]
   */
  emit(event, data = {}) {
    this._seq += 1;
    const elapsedMs = Date.now() - this._t0;
    if (!this._events.has(event)) {
      this._events.set(event, elapsedMs);
    }
    logger.info('[STREAM_TIMELINE]', {
      sessionId: this.sessionId,
      seq: this._seq,
      event,
      t: `+${elapsedMs}ms`,
      ...data
    });
    return elapsedMs;
  }

  /** @returns {object} snapshot for stream_started / stream_status */
  snapshot() {
    const out = { sessionId: this.sessionId, elapsedMs: Date.now() - this._t0 };
    for (const [k, v] of this._events) out[k] = v;
    return out;
  }
}

module.exports = { StreamTimeline };
