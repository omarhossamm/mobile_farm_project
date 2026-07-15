'use strict';

/**
 * CaptureSupervisor — startup failover across a priority-ordered provider chain.
 *
 * Probe selection (ProviderRegistry) already filters out providers that can't
 * possibly work. The supervisor adds RUNTIME verification: it actually starts a
 * candidate and waits for the first encoded frame. If the candidate dies during
 * the startup window (helper crash, idb hiccup) before producing any data, the
 * supervisor disposes it and transparently tries the next candidate — so a
 * broken primary (CoreSimulator) silently falls back to the transcode tier
 * without the client ever noticing.
 *
 * Early frames received during the verification window are BUFFERED and returned
 * so the caller can replay them into the H.264 pipeline — no frame is lost.
 *
 * Once a capture is verified, ongoing health is the StreamManager's concern
 * (single-shot teardown on 'ended'); the supervisor only governs startup.
 *
 * @module stream/core/CaptureSupervisor
 */

const { createLogger } = require('../../lib/logger');

const logger = createLogger('CAPTURE_SUPERVISOR');

const DEFAULT_FIRST_FRAME_MS = parseInt(process.env.CAPTURE_FIRST_FRAME_MS, 10) || 6000;

class CaptureSupervisor {
  /**
   * @param {object} opts
   * @param {number} [opts.firstFrameTimeoutMs]
   */
  constructor(opts = {}) {
    this._firstFrameTimeoutMs = opts.firstFrameTimeoutMs || DEFAULT_FIRST_FRAME_MS;
  }

  /**
   * Try each provider in order until one produces a first frame.
   *
   * @param {object} params
   * @param {Array} params.chain        ordered capture providers (priority high→low)
   * @param {object} params.handle      DeviceHandle
   * @param {object} params.captureOpts options for provider.startCapture
   * @returns {Promise<{capture: object, providerId: string, bufferedChunks: Buffer[], streamMeta: object|null}>}
   * @throws if every candidate fails to produce a first frame
   */
  async selectAndStart({ chain, handle, captureOpts }) {
    if (!Array.isArray(chain) || chain.length === 0) {
      throw new Error('CaptureSupervisor: empty provider chain');
    }

    const failures = [];
    for (const provider of chain) {
      const providerId = provider.providerId;
      let capture;
      try {
        capture = await provider.startCapture(handle, captureOpts);
      } catch (err) {
        logger.warn('Provider startCapture threw — trying next', { providerId, error: err.message });
        failures.push(`${providerId}: startCapture ${err.message}`);
        continue;
      }

      const result = await this._verify(capture, providerId);
      if (result.ok) {
        logger.info('Capture verified', {
          providerId,
          bufferedChunks: result.bufferedChunks.length
        });
        // The buffer listener stays attached so no frame is lost between here
        // and the caller adopting the stream. adopt() must be called exactly
        // once, synchronously, after wiring the real consumer.
        return {
          capture,
          providerId,
          streamMeta: result.streamMeta,
          bufferedChunks: result.bufferedChunks,
          // The still-attached verification buffer listener. The caller must
          // detach it (capture.removeListener('data', bufferListener)) once it
          // has wired its own 'data' consumer, then replay bufferedChunks. This
          // is exposed for callers that attach their consumer separately (e.g.
          // StreamManager via _wireCaptureEvents); callers that don't can use
          // adopt() below instead, but never both.
          bufferListener: result.bufferListener,
          /**
           * Atomically hand the stream to a real consumer with zero gap and no
           * duplicates: attach consumer, detach the buffer listener, then replay
           * historical frames (all synchronous — the event loop cannot interleave).
           * @param {(chunk: Buffer) => void} consumer
           */
          adopt(consumer) {
            capture.on('data', consumer);
            capture.removeListener('data', result.bufferListener);
            for (const chunk of result.bufferedChunks) consumer(chunk);
          }
        };
      }

      logger.warn('Capture failed startup — falling back', { providerId, reason: result.reason });
      failures.push(`${providerId}: ${result.reason}`);
      try { capture.stop(); } catch { /* ignore */ }
    }

    throw new Error(`All capture providers failed startup:\n  ${failures.join('\n  ')}`);
  }

  /**
   * Start a single capture and wait for the first frame. On success the buffer
   * listener REMAINS attached (caller adopts via the returned helper); on
   * failure all listeners are removed.
   * @returns {Promise<{ok:boolean, reason?:string, bufferedChunks:Buffer[], streamMeta:object|null, bufferListener:Function}>}
   */
  _verify(capture, providerId) {
    return new Promise((resolve) => {
      const buffered = [];
      let streamMeta = null;
      let settled = false;

      const bufferListener = (chunk) => { buffered.push(chunk); };
      const onFirstData = () => { if (!settled) finish({ ok: true }); };
      const onMeta = (meta) => { streamMeta = meta; };
      const onEnded = (info) => finish({ ok: false, reason: info?.reason || 'ended' });
      const onError = (err) => finish({ ok: false, reason: err?.message || 'error' });

      // NOTE: intentionally NOT unref'd — the timer is always cleared on settle,
      // and it must keep the loop alive long enough to drive failover.
      const timer = setTimeout(() => finish({ ok: false, reason: 'first-frame timeout' }), this._firstFrameTimeoutMs);

      function finish(res) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        capture.removeListener('data', onFirstData);
        capture.removeListener('streamMeta', onMeta);
        capture.removeListener('ended', onEnded);
        capture.removeListener('error', onError);
        if (!res.ok) capture.removeListener('data', bufferListener);
        resolve({
          ...res,
          bufferedChunks: buffered,
          bufferListener,
          streamMeta: streamMeta || (capture.getStreamMeta?.() ?? null)
        });
      }

      // Order matters: buffer listener first so it captures the same first chunk
      // that triggers onFirstData (EventEmitter invokes listeners in add order).
      capture.on('data', bufferListener);
      capture.on('data', onFirstData);
      capture.on('streamMeta', onMeta);
      capture.once('ended', onEnded);
      capture.once('error', onError);

      Promise.resolve()
        .then(() => capture.start())
        .then((r) => {
          if (r && r.success === false) finish({ ok: false, reason: r.error || 'start failed' });
        })
        .catch((err) => finish({ ok: false, reason: err?.message || 'start threw' }));
    });
  }
}

module.exports = { CaptureSupervisor };
