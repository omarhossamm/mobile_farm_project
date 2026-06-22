/**
 * Server-side streaming: adb screenrecord → H.264 RTP (werift) → desktop WebRTC.
 * MediaStartupGate: no RTP until SDP (local+remote) + DTLS + SPS/PPS flushed, then immediate send enabled.
 */

const { EventEmitter } = require('events');
const { peerConnectionManager } = require('./webrtc/PeerConnection');
const { createCapture } = require('./capture/factory');
const {
  H264RtpPacketizer,
  processH264Chunk,
  tickAnnexBDrain,
  createStreamProcessorState,
  enableRtpEmit,
  hasSpsAndPps,
  getParamSetNals,
  canEmitIdr
} = require('./media/h264');
const { OutputPacer } = require('./OutputPacer');
const {
  STATE,
  createMediaStartupGate,
  snapshot,
  tryOpen,
  markFlag
} = require('./MediaStartupGate');
const { controlRouter } = require('../control/ControlRouter');
const { streamConfig } = require('../lib/config');
const { createLogger } = require('../lib/logger');
const { StreamTimeline } = require('./core/StreamTimeline');
const { buildStreamMeta } = require('./core/buildStreamMeta');

const logger = createLogger('STREAM_MGR');
const CODEC_WAIT_MS = parseInt(process.env.STREAM_CODEC_WAIT_MS, 10) || 30000;
const DECODER_WARMUP_MS = clampInt(parseInt(process.env.STREAM_DECODER_WARMUP_MS, 10), 150, 100, 2000);

/**
 * Periodic STAP-A (SPS+PPS) refresh interval. Defaults to 2 s — without this
 * the receiver's FFmpeg can never recover from a single lost bootstrap STAP-A
 * (UDP, no retransmit) until the screenrecord segment restarts. Set to 0 to
 * disable.
 */
const PARAM_REFRESH_MS = clampInt(parseInt(process.env.STREAM_PARAM_REFRESH_MS, 10), 2000, 0, 30000);

/**
 * Cadence for the "Frame send heartbeat" log. The heartbeat surfaces pacer
 * drops, queue depth, capture chunk jitter and H.264 processor counters at a
 * glance — invaluable when diagnosing intermittent decoder corruption.
 */
const HEARTBEAT_MS = clampInt(parseInt(process.env.STREAM_HEARTBEAT_MS, 10), 5000, 1000, 60000);

/**
 * How long (ms) the pacer can be idle after the gate opens before a
 * `stream_stall` WebSocket message is sent to the desktop.  This lets the
 * client overlay a visual indicator instead of showing a frozen frame.
 * Defaults to 500 ms — slightly above the capture STALL_RECOVERY_MS (400 ms)
 * to avoid false positives from normal IDR spacing.
 */
const STALL_NOTIFY_MS = clampInt(
  parseInt(process.env.STREAM_STALL_NOTIFY_MS, 10),
  2000,
  500,
  10000
);

/**
 * Grace window (ms) after an input event during which a new video frame is
 * expected. If the user interacted (tap/swipe/key) and no frame arrives within
 * this window, the encoder is treated as stuck and the capture is reconnected
 * once. A plain static screen (no input) NEVER triggers this — that prevents
 * the reconnect loop seen when idle screens produce no VCL frames.
 */
const INPUT_STALL_RECOVERY_MS = clampInt(
  parseInt(process.env.STREAM_INPUT_STALL_RECOVERY_MS, 10),
  1500,
  500,
  10000
);

function clampInt(value, fallback, lo, hi) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(hi, Math.max(lo, value));
}

/** @returns {object|null} H.264 processor state with param cache initialized */
function getProcessorState(entry) {
  const state = entry?.ctx?.state;
  if (!state) return null;
  const { ensureParamSetState } = require('./media/h264/paramSetCache');
  return ensureParamSetState(state);
}

function detectH264Format(chunk) {
  if (!chunk || chunk.length < 4) return 'annexb';
  if (chunk[0] === 0x00 && chunk[1] === 0x00 && chunk[2] === 0x00 && chunk[3] === 0x01) return 'annexb';
  if (chunk[0] === 0x00 && chunk[1] === 0x00 && chunk[2] === 0x01) return 'annexb';
  if (chunk.length >= 8 && chunk.slice(4, 8).toString('ascii') === 'ftyp') return 'avcc';
  const nalLen = chunk.readUInt32BE(0);
  if (nalLen > 0 && nalLen < 2_000_000 && chunk.length >= 4 + nalLen) return 'avcc';
  return 'annexb';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a minimal DeviceHandle for Android sessions that were created before
 * platformHost.bindSession() was called (the legacy create_session path).
 * Enough for ProviderRegistry.resolveCapture() to probe in priority order.
 *
 * @param {string} deviceId   ADB serial (e.g. 'emulator-5554', '192.168.1.5:5555')
 * @param {object} session    WebSocket session object
 * @returns {import('../platform/types').DeviceHandle}
 */
function _makeAndroidHandle(deviceId, session) {
  // Heuristic: emulator-NNNN → 'emulator',  HOST:PORT → 'physical'
  const targetClass = deviceId.startsWith('emulator-') ? 'emulator'
    : deviceId.includes(':') ? 'physical'
    : (session.metadata?.targetClass || 'emulator');

  return {
    ref: {
      id:          deviceId,
      platform:    'android',
      targetClass,
      status:      'online',
      displayName: deviceId
    },
    sessionId: session.id
  };
}

class StreamManager {
  constructor() {
    this._sessions = new Map();
    peerConnectionManager.setPipelineStartHandler((sessionId) => this._startPipeline(sessionId));
    peerConnectionManager.setMediaReadyHandler((sessionId) => {
      const entry = this._sessions.get(sessionId);
      if (entry) {
        markFlag(entry.gate, 'dtlsReady', true, 'dtls_connected');
        this._tryCompleteStartup(sessionId, 'dtls_connected').catch((err) => {
          logger.error('Startup failed after DTLS', { sessionId, error: err.message });
        });
      }
    });
  }

  hasSession(sessionId) {
    return this._sessions.has(sessionId);
  }

  /** STAP-A bootstrap only — allowed before gate opens (still requires DTLS). */
  _sendBootstrapRtp(sessionId, packets) {
    if (!peerConnectionManager.isMediaReady(sessionId)) {
      return { success: false, dropped: true, reason: 'media_not_ready' };
    }
    return peerConnectionManager.sendFrame(sessionId, packets);
  }

  _sendRtp(entry, sessionId, packets) {
    if (!entry.gate.open) {
      return { success: false, dropped: true, reason: 'startup_gate_closed' };
    }
    if (!peerConnectionManager.isMediaReady(sessionId)) {
      return { success: false, dropped: true, reason: 'media_not_ready' };
    }
    return peerConnectionManager.sendFrame(sessionId, packets);
  }

  /**
   * State transition: SEND_SPS_PPS → WAIT_DECODER → STREAMING.
   * Sends STAP-A bootstrap on its own RTP packet, then waits the warm-up
   * before allowing any VCL frame on the wire.
   */
  async _flushParamSetsAndOpenGate(entry, sessionId, reason) {
    const { gate, packetizer } = entry;
    const state = getProcessorState(entry);
    if (!state) {
      logger.warn('No processor state for STAP flush', { sessionId, reason });
      return false;
    }
    if (gate.open) return true;
    if (gate.paramSetsFlushed) {
      this._startDecoderWarmup(entry, sessionId, reason);
      return gate.open;
    }

    if (!canEmitIdr(state)) {
      return false;
    }

    const stap = packetizer.packetizeStapA(
      getParamSetNals(state),
      state.nextRtpTimestamp,
      true
    );
    if (!stap.length) {
      logger.warn('STAP-A build failed — cannot open startup gate', { sessionId });
      return false;
    }

    if (!gate.dtlsReady || !peerConnectionManager.isMediaReady(sessionId)) {
      entry.pendingParamSetPackets = stap;
      return false;
    }

    const send = this._sendBootstrapRtp(sessionId, stap);
    if (!send.success) {
      entry.pendingParamSetPackets = stap;
      return false;
    }

    state.paramSetsRtpSent = true;
    markFlag(gate, 'paramSetsFlushed', true, reason);
    entry.pendingParamSetPackets = null;
    // Advance the RTP timestamp so the first VCL frame is on its own tick
    // (no STAP-A and IDR sharing a timestamp; RFC 6184 §5.1).
    const tsStep = Math.max(1, Math.floor(90000 / (entry.ctx.options.fps || 20)));
    state.nextRtpTimestamp = (state.nextRtpTimestamp + tsStep) >>> 0;
    logger.info('STAP-A bootstrap flushed (SPS + PPS standalone)', {
      sessionId,
      reason,
      spsBytes: state.sps.length,
      ppsBytes: state.pps.length,
      nextRtpTimestamp: state.nextRtpTimestamp
    });

    if (typeof entry.capture?.requestKeyframe === 'function') {
      entry.capture.requestKeyframe();
    }

    this._startDecoderWarmup(entry, sessionId, reason);
    return gate.open;
  }

  /**
   * Hold VCL traffic for DECODER_WARMUP_MS so the receiver's FFmpeg has time
   * to accept SPS/PPS before the first IDR slice arrives.
   */
  _startDecoderWarmup(entry, sessionId, reason) {
    const { gate, ctx } = entry;
    if (gate.decoderReady) {
      this._openGateForVcl(entry, sessionId, reason);
      return;
    }
    if (entry.decoderWarmupTimer) return;

    const warmupMs = DECODER_WARMUP_MS;
    logger.info('Decoder warm-up started', { sessionId, reason, warmupMs });

    entry.decoderWarmupTimer = setTimeout(() => {
      entry.decoderWarmupTimer = null;
      markFlag(gate, 'decoderReady', true, 'warmup_elapsed');
      logger.info('Decoder warm-up elapsed — opening gate for VCL', {
        sessionId,
        reason,
        warmupMs
      });
      this._openGateForVcl(entry, sessionId, reason);
    }, warmupMs);
    if (typeof entry.decoderWarmupTimer.unref === 'function') {
      entry.decoderWarmupTimer.unref();
    }

    // While waiting, keep capture parsing but do not let anything leave.
    entry.pacer.setEnabled(false);
    ctx.options.emitRtp = false;
  }

  _openGateForVcl(entry, sessionId, reason) {
    const { gate, ctx } = entry;
    if (!tryOpen(gate, reason)) return;

    entry.gateOpenAt = Date.now();
    entry.rtpSendEnabled = true;
    ctx.options.emitRtp = true;
    entry.pacer.setEnabled(true);

    tickAnnexBDrain(ctx);
    const discarded = enableRtpEmit(ctx);
    if (discarded > 0) {
      logger.info('Pre-gate buffer discarded — burst prevention', { sessionId, discarded });
    }

    if (!entry.pacerStarted) {
      entry.pacer.start();
      entry.pacerStarted = true;
      if (entry.drainTimer) clearInterval(entry.drainTimer);
      entry.drainTimer = setInterval(() => tickAnnexBDrain(ctx), 50);
      if (typeof entry.drainTimer.unref === 'function') entry.drainTimer.unref();
    }

    if (PARAM_REFRESH_MS > 0 && !entry.paramRefreshTimer) {
      entry.paramRefreshTimer = setInterval(
        () => this._refreshParamSets(entry, sessionId),
        PARAM_REFRESH_MS
      );
      if (typeof entry.paramRefreshTimer.unref === 'function') {
        entry.paramRefreshTimer.unref();
      }
    }

    if (!entry.heartbeatTimer) {
      entry.heartbeatTimer = setInterval(
        () => this._emitHeartbeat(entry, sessionId),
        HEARTBEAT_MS
      );
      if (typeof entry.heartbeatTimer.unref === 'function') {
        entry.heartbeatTimer.unref();
      }
    }

    if (!entry.stallNotifyTimer) {
      entry.stallNotifyTimer = setInterval(() => {
        if (!entry.gate.open) return;
        if (!entry.capture.getStatus().running) return;
        const now = Date.now();
        const idleMs = entry.lastVclSentAt > 0 ? now - entry.lastVclSentAt : 0;

        // Cosmetic UI hint: the picture is static. This is NORMAL for an idle
        // screen (scrcpy/MediaCodec only emits on change) and does NOT trigger
        // any capture teardown.
        const isStalling = idleMs > STALL_NOTIFY_MS;
        if (isStalling && !entry.stallIsNotified) {
          entry.stallIsNotified = true;
          const sess = entry.session;
          if (sess?.ws?.readyState === 1) {
            try { sess.send({ type: 'stream_stall', session_id: sessionId, idleMs }); } catch (_) {}
          }
        }

        // Genuine-stuck recovery: the user interacted (input injected) AFTER the
        // last delivered frame, yet no new frame followed within the grace
        // window. The screen should have changed but didn't — reconnect once.
        const inputAfterFrame = entry.lastInputAt > 0
          && entry.lastInputAt >= (entry.lastVclSentAt || 0);
        const inputIdleMs = inputAfterFrame ? now - entry.lastInputAt : 0;
        if (inputAfterFrame
            && inputIdleMs > INPUT_STALL_RECOVERY_MS
            && !entry.stallRecoveryRequested
            && typeof entry.capture?.requestRecovery === 'function') {
          entry.stallRecoveryRequested = true;
          logger.warn('Input without frame — requesting capture recovery', {
            sessionId,
            inputIdleMs
          });
          entry.capture.requestRecovery('input_without_frame').catch((err) => {
            logger.warn('Capture recovery after input stall failed', {
              sessionId,
              error: err.message
            });
            entry.stallRecoveryRequested = false;
          });
        }
      }, 200);
      if (typeof entry.stallNotifyTimer.unref === 'function') {
        entry.stallNotifyTimer.unref();
      }
    }
  }

  /**
   * Record that an input event was injected for this session. Used by the
   * stall watchdog to distinguish a genuinely stuck encoder (user interacted
   * but the frame never updated) from a normal static screen.
   */
  notifyInput(sessionId) {
    const entry = this._sessions.get(sessionId);
    if (entry) entry.lastInputAt = Date.now();
  }

  /**
   * Periodic visibility into the streaming pipeline. Surfaces:
   *   - pacer queue depth / drops (P-frame chain safety)
   *   - capture chunk jitter (informs reactive-drain safety)
   *   - H.264 processor counters (param retention, IDR deferrals)
   *   - peer RTP counters (packets/frames actually on the wire)
   */
  _emitHeartbeat(entry, sessionId) {
    if (!entry || !this._sessions.has(sessionId)) return;
    try {
      const now = Date.now();
      const pacer = entry.pacer.stats;
      const h264 = entry.ctx.stats;
      const peer = peerConnectionManager.getStats(sessionId) || {};
      const captureStatus = entry.capture.getStatus() || {};
      const capture = captureStatus.stats || {};
      const idr = h264.keyframesWithSpsPps || 0;
      const sent = pacer.sent || 0;

      const spsInfo = getProcessorState(entry)?.spsInfo ?? null;

      // Per-heartbeat-window observed FPS (frames sent / window seconds).
      const windowSent = sent - (entry.prevHeartbeatSent || 0);
      const windowMs = entry.prevHeartbeatAt ? now - entry.prevHeartbeatAt : HEARTBEAT_MS;
      const windowFps = windowMs > 0 ? Math.round((windowSent / windowMs) * 1000 * 10) / 10 : 0;
      entry.prevHeartbeatSent = sent;
      entry.prevHeartbeatAt = now;

      // Startup timing (null until gate opens / first frame fires).
      const startupTimeMs = (entry.gateOpenAt && entry.firstFrameEmittedAt)
        ? entry.firstFrameEmittedAt - entry.gateOpenAt
        : null;
      const totalStartMs = entry.firstFrameEmittedAt
        ? entry.firstFrameEmittedAt - entry.streamStartAt
        : null;

      logger.info('Frame send heartbeat', {
        sessionId,
        captureProvider: entry.capture?.providerId ?? captureStatus.mode ?? 'unknown',
        sent,
        idrSent: idr,
        pSent: Math.max(0, sent - idr),
        windowFps,
        startupTimeMs,
        totalStartMs,
        spsNumRefFrames: spsInfo?.numRefFrames ?? null,
        spsProfile: spsInfo?.profileIdc ?? null,
        spsLevel: spsInfo?.levelIdc ?? null,
        droppedAtIdr: pacer.droppedAtIdr || 0,
        droppedNoIdrFallback: pacer.droppedNoIdrFallback || 0,
        idleRepeats: pacer.idleRepeats || 0,
        sendMode: pacer.mode || 'immediate',
        queueDepth: pacer.queueDepth || 0,
        queueDepthPeak: pacer.queueDepthPeak || 0,
        pacerFps: pacer.fps || 0,
        lastDropReason: pacer.lastDropReason || null,
        captureStallRecoveries: h264.captureStallRecoveries || 0,
        stalePartialDiscarded: h264.stalePartialDiscarded || 0,
        partialPFrameRetained: h264.partialPFrameRetained || 0,
        idlePFrameDrain: h264.idlePFrameDrain || 0,
        skippedTinyPFrames: h264.skippedTinyPFrames || 0,
        deferredIdrNoParams: h264.deferredIdrNoParams || 0,
        discardedPreGateFrames: h264.discardedPreGateFrames || 0,
        framesEmitted: h264.framesEmitted || 0,
        keyframesWithSpsPps: h264.keyframesWithSpsPps || 0,
        chunksReceived: h264.chunksReceived || 0,
        maxChunkGapMs: h264.maxChunkGapMs || 0,
        maxChunkBytes: h264.maxChunkBytes || 0,
        captureBytes: capture.bytes || 0,
        captureChunks: capture.chunks || 0,
        ffmpegStderrErrors: capture.ffmpegStderrErrors || 0,
        rtpFrames: peer.framesSent || 0,
        rtpPackets: peer.packetsSent || 0
      });
    } catch (err) {
      logger.warn('Heartbeat emit failed', { sessionId, error: err.message });
    }
  }

  /**
   * Optional resilience: re-emit STAP-A (no IDR) every PARAM_REFRESH_MS so a
   * late-joining decoder or one that lost the bootstrap can recover.
   */
  _refreshParamSets(entry, sessionId) {
    const state = getProcessorState(entry);
    if (!state || !canEmitIdr(state)) return;
    const stap = entry.packetizer.packetizeStapA(
      getParamSetNals(state),
      state.nextRtpTimestamp,
      true
    );
    if (!stap.length) return;
    const sent = this._sendRtp(entry, sessionId, stap, 'paramRefresh');
    if (sent.success) {
      const tsStep = Math.max(1, Math.floor(90000 / (entry.ctx.options.fps || 20)));
      state.nextRtpTimestamp = (state.nextRtpTimestamp + tsStep) >>> 0;
    }
  }

  async _tryCompleteStartup(sessionId, reason) {
    try {
      const entry = this._sessions.get(sessionId);
      if (!entry || entry.gate.open) return;

      const state = getProcessorState(entry);
      if (state && hasSpsAndPps(state)) {
        markFlag(entry.gate, 'codecParamsReady', true, reason);
      }

      if (!entry.gate.sdpLocalReady || !entry.gate.sdpRemoteReady ||
          !entry.gate.dtlsReady || !entry.gate.codecParamsReady) {
        logger.debug('Startup gate waiting', { sessionId, reason, ...snapshot(entry.gate) });
        return;
      }

      if (!entry.gate.paramSetsFlushed) {
        await this._flushParamSetsAndOpenGate(entry, sessionId, reason);
      }
    } catch (err) {
      logger.error('Startup gate error', {
        sessionId,
        reason,
        error: err.message,
        stack: err.stack
      });
    }
  }

  async _waitForCodecParams(entry, sessionId) {
    const start = Date.now();
    while (Date.now() - start < CODEC_WAIT_MS) {
      const state = getProcessorState(entry);
      if (state && canEmitIdr(state)) {
        markFlag(entry.gate, 'codecParamsReady', true, 'capture_sps_pps');
        logger.info('Codec params ready (SPS+PPS in pipeline)', {
          sessionId,
          spsBytes: state.sps?.length,
          ppsBytes: state.pps?.length,
          waitedMs: Date.now() - start
        });
        return true;
      }
      await sleep(50);
    }
    logger.warn('Timed out waiting for SPS/PPS from screenrecord', { sessionId, CODEC_WAIT_MS });
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Capture event wiring
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Wire data + lifecycle events for a capture stream onto an existing
   * session entry.
   *
   * @param {object} entry        Session entry from this._sessions
   * @param {object} capture      The capture stream to wire
   * @param {string} sessionId
   * @param {object} state        H.264 processor state (same object throughout)
   * @param {object} ctx          H.264 processor context
   */
  /** Single ingestion point for capture chunks (live + supervised replay). */
  _ingestChunk(state, ctx, sessionId, chunk) {
    if (!state.formatDetected && chunk.length > 0) {
      state.format = detectH264Format(chunk);
      state.formatDetected = true;
      logger.info('H.264 format detected', { sessionId, format: state.format });
    }
    processH264Chunk(ctx, chunk);
  }

  _wireCaptureEvents(entry, capture, sessionId, state, ctx) {
    const providerId = capture.providerId;

    if (!entry.timeline) {
      entry.timeline = new StreamTimeline(sessionId);
    }
    entry.timeline.emit('capture.started', { provider: providerId });

    capture.on('data', (chunk) => this._ingestChunk(state, ctx, sessionId, chunk));

    capture.on('ended', (info) => {
      this._handleCaptureEnded(sessionId, info);
    });

    capture.on('recovered', (info) => {
      logger.info('Capture recovered after stall — resetting codec state', {
        sessionId,
        provider: providerId,
        ...info
      });
      entry.stallRecoveryRequested = false;
      this._resetCaptureState(entry);
      const sess = entry.session;
      if (sess?.ws?.readyState === 1) {
        try { sess.send({ type: 'scene_cut', session_id: sessionId }); } catch (_) {}
      }
      this._tryCompleteStartup(sessionId, 'capture_recovered').catch((err) => {
        logger.error('Startup failed after capture recovery', { sessionId, error: err.message });
      });
    });

    capture.on('error', (err) => {
      logger.error('Capture error — treating as fatal', { sessionId, error: err.message });
      this._handleCaptureEnded(sessionId, { reason: 'capture_error', error: err.message });
    });
  }

  /**
   * Reset all H.264 codec state so a newly-started capture provider produces
   * a clean SPS+PPS+IDR sequence without contamination from the old encoder.
   *
   * Mutates `entry.ctx.state` and `entry.gate` in-place — the existing object
   * references held by closures remain valid throughout the reset.
   *
   * Gate flags that reflect network signalling (sdpLocalReady, sdpRemoteReady,
   * dtlsReady) are intentionally left untouched: the peer connection is still
   * alive and those handshakes do NOT need to repeat.
   *
   * @param {object} entry  Session entry from this._sessions
   */
  _resetCaptureState(entry) {
    const { ctx, gate } = entry;
    const state = ctx.state;

    // Cancel any in-flight timers so they don't fire on stale state.
    if (state.reactiveDrainTimer) {
      clearTimeout(state.reactiveDrainTimer);
      state.reactiveDrainTimer = null;
    }
    if (entry.decoderWarmupTimer) {
      clearTimeout(entry.decoderWarmupTimer);
      entry.decoderWarmupTimer = null;
    }

    // ── H.264 processor state ─────────────────────────────────────────────
    // Wipe the byte buffer — any partial NAL from the old encoder is garbage
    // to the new encoder and would corrupt the first decoded frame.
    state.buffer              = Buffer.alloc(0);
    state.auNals              = [];
    state.gotFirstKeyframe    = false;
    state.lastKeyframeEmitAt  = 0;
    state.framesOut           = 0;
    state.firstLiveFrameEmitted = false;
    state.formatDetected      = false;
    state.paramSetsRtpSent    = false;
    state.pendingRtpFrames    = [];
    state.lastChunkSize       = 0;
    state.afterStall          = false;

    // ── Param-set cache ───────────────────────────────────────────────────
    // SPS / PPS from the old encoder are invalid for the new one (different
    // profile, resolution, or level).  Mirror what initParamSetState() sets.
    state.receivedSps  = false;
    state.receivedPps  = false;
    state.sps          = null;
    state.pps          = null;
    state.spsInfo      = null;
    state.lastSpsRaw   = null;
    state.lastPpsRaw   = null;

    // ── Media startup gate (codec side only) ──────────────────────────────
    // Re-enter WAIT_CODEC.  The next provider's SPS+IDR will drive the gate
    // back through SEND_SPS_PPS → WAIT_DECODER → STREAMING automatically.
    gate.codecParamsReady = false;
    gate.paramSetsFlushed = false;
    gate.decoderReady     = false;
    gate.open             = false;
    gate.lastState        = STATE.WAIT_CODEC;

    // ── RTP pipeline ──────────────────────────────────────────────────────
    entry.rtpSendEnabled         = false;
    ctx.options.emitRtp          = false;
    entry.pendingParamSetPackets = null;
    entry.pacer.setEnabled(false);
  }

  /**
   * Capture has exited (time-limit, crash, device disconnect). Per the
   * single-shot policy we DO NOT restart the encoder. The whole session is
   * torn down and the desktop is notified to reconnect with a fresh session.
   */
  _handleCaptureEnded(sessionId, info) {
    const entry = this._sessions.get(sessionId);
    if (!entry || entry.captureEndedHandled) return;
    entry.captureEndedHandled = true;

    logger.warn('Capture ended — tearing down session (single-shot policy)', {
      sessionId,
      reason: info?.reason || 'unknown',
      code: info?.code,
      signal: info?.signal,
      stderr: info?.stderr ? String(info.stderr).slice(0, 200) : undefined
    });

    const session = entry.session;
    const reason = info?.reason || 'unknown';
    const provider = entry.capture?.providerId ?? 'capture';
    const errorMsg = `${provider} ended (${reason}). Reconnect required.`;

    if (session?.ws?.readyState === 1) {
      try {
        session.send({
          type: 'stream_error',
          session_id: sessionId,
          fatal: true,
          reason: info?.reason || 'capture_ended',
          error: errorMsg
        });
      } catch (err) {
        logger.warn('Failed to notify desktop of capture end', { sessionId, error: err.message });
      }
    }

    this.stopStream(sessionId);
  }

  async startStream(session, options = {}) {
    const sessionId = session.id;
    const deviceId = session.deviceId;

    if (this._sessions.has(sessionId)) {
      await this.stopStream(sessionId);
    }

    const peerResult = peerConnectionManager.createPeer(sessionId);
    if (!peerResult.success) {
      return { success: false, error: peerResult.error };
    }

    peerConnectionManager.attachPeer(sessionId, session);

    const fps = options.fps || streamConfig.fps;

    // Route ALL capture creation through the ProviderRegistry so that
    // config/providers.js priority order is honoured for every platform.
    //
    // Android sessions arrive without session.deviceHandle (the legacy
    // createSession path never calls platformHost.bindSession for Android).
    // We synthesise a minimal DeviceHandle so the registry can probe providers
    // in the configured priority order (scrcpy-capture → adb-screenrecord).
    //
    // Registry sessions carry session.deviceHandle from platformHost.bindSession.
    const handle = session.deviceHandle ?? _makeAndroidHandle(deviceId, session);

    let capture;
    let captureProviderId = 'unknown';
    const isIos = handle.ref.platform === 'ios';
    const captureOpts = isIos
      ? {
          // CoreSimulator/idb capture is native-resolution; width/height are
          // informational. fps + bitrate drive the VideoToolbox/x264 encoder.
          bitRate: options.bitRate || streamConfig.iosBitrate,
          fps:     options.fps     || streamConfig.iosFps
        }
      : {
          maxSize: options.maxSize || streamConfig.androidMaxSize,
          width:   options.width   || streamConfig.androidWidth,
          height:  options.height  || streamConfig.androidHeight,
          bitRate: options.bitRate || streamConfig.androidBitrate,
          fps:     options.fps     || streamConfig.androidFps || fps
        };

    // Supervised startup failover (iOS): try the whole probe-passing chain and
    // verify each candidate actually produces a first frame, transparently
    // falling back (coresim → idb-transcode) without a client reconnect.
    let supervised = null;

    {
      const { platformHost } = require('../platform');

      if (isIos) {
        let chain;
        try {
          chain = await platformHost.registry.resolveCaptureChain(handle);
        } catch (err) {
          peerConnectionManager.closePeer(sessionId);
          if (err.code === 'CAPTURE_PERMISSION_DENIED') {
            return { success: false, reason: 'permission_denied', error: err.message };
          }
          return { success: false, error: `No capture provider available: ${err.message}` };
        }
        if (!chain.length) {
          peerConnectionManager.closePeer(sessionId);
          return { success: false, error: 'No capture provider available for iOS simulator' };
        }
        try {
          const { CaptureSupervisor } = require('./core/CaptureSupervisor');
          supervised = await new CaptureSupervisor().selectAndStart({ chain, handle, captureOpts });
        } catch (err) {
          peerConnectionManager.closePeer(sessionId);
          logger.error('iOS capture supervisor failed', { sessionId, error: err.message });
          return { success: false, error: `Capture start failed: ${err.message}` };
        }
        capture = supervised.capture;
        captureProviderId = supervised.providerId;
      } else {
        let provider;
        try {
          provider = await platformHost.registry.resolveCapture(handle);
        } catch (err) {
          peerConnectionManager.closePeer(sessionId);

          if (err.code === 'CAPTURE_PERMISSION_DENIED') {
            logger.warn('Capture blocked: permission denied', {
              sessionId,
              providerId: err.providerId,
              error: err.message
            });
            return { success: false, reason: 'permission_denied', error: err.message };
          }

          logger.error('No capture provider resolved', { sessionId, error: err.message });
          return { success: false, error: `No capture provider available: ${err.message}` };
        }

        captureProviderId = provider.providerId;

        try {
          capture = await provider.startCapture(handle, captureOpts);
        } catch (err) {
          peerConnectionManager.closePeer(sessionId);
          logger.error('Capture failed to start', { sessionId, providerId: captureProviderId, error: err.message });
          return { success: false, error: `Capture start failed (${captureProviderId}): ${err.message}` };
        }
      }

      logger.info('Capture provider selected', {
        sessionId,
        providerId: captureProviderId,
        platform:   handle.ref.platform,
        targetClass: handle.ref.targetClass,
        supervised: !!supervised
      });
    }

    const packetizer = new H264RtpPacketizer();
    const emitter = new EventEmitter();
    const stats = { bytesIn: 0, nalsParsed: 0, framesEmitted: 0 };
    const state = createStreamProcessorState({ format: 'annexb' });
    const keyframesOnly = options.keyframesOnly ?? streamConfig.keyframesOnly;
    const frameDelimited = captureProviderId === 'scrcpy-capture';
    const ctx = {
      emitter,
      packetizer,
      stats,
      options: {
        fps,
        keyframesOnly,
        frameDelimited,
        emitRtp: false
      },
      state
    };
    const gate = createMediaStartupGate(sessionId);

    const entry = {
      session,
      capture,
      ctx,
      packetizer,
      gate,
      pipelineStarted: false,
      pacerStarted: false,
      rtpSendEnabled: false,
      pendingParamSetPackets: null,
      decoderWarmupTimer: null,
      paramRefreshTimer: null,
      heartbeatTimer: null,
      captureEndedHandled: false,
      timeline: new StreamTimeline(sessionId),
      // A/B comparison timing
      streamStartAt: Date.now(),
      gateOpenAt: 0,
      firstFrameEmittedAt: 0,
      // Per-heartbeat-window FPS tracking
      prevHeartbeatSent: 0,
      prevHeartbeatAt: 0,
      // Input-correlated stall recovery
      lastInputAt: 0,
      stallRecoveryRequested: false
    };

    entry.sendParamSetPackets = (packets) => {
      const send = this._sendRtp(entry, sessionId, packets, 'paramSets');
      if (send.success) {
        state.paramSetsRtpSent = true;
        gate.paramSetsFlushed = true;
        entry.pendingParamSetPackets = null;
      } else {
        entry.pendingParamSetPackets = packets;
      }
    };

    entry.deliverFrame = (frame) => {
      if (!entry.gate.open) return;
      const st = getProcessorState(entry);
      if (!st) return;

      if (frame.isParamSetsOnly) {
        entry.sendParamSetPackets(frame.packets);
        return;
      }

      if (frame.isKeyframe) {
        if (!st.paramSetsRtpSent) {
          logger.warn('Blocked IDR — bootstrap STAP-A not yet sent', { sessionId });
          return;
        }
        if (!gate.paramSetsFlushed || !gate.decoderReady) {
          logger.warn('Blocked IDR — decoder not ready', { sessionId, state: snapshot(gate) });
          return;
        }
        entry.pacer.submit(frame);
        return;
      }

      if (!st.gotFirstKeyframe) return;
      entry.pacer.submit(frame);
    };

    entry.lastVclSentAt = 0;
    entry.stallIsNotified = false;
    entry.pacer = new OutputPacer(fps, (frame) => {
      entry.lastVclSentAt = Date.now();
      entry.stallRecoveryRequested = false;
      if (entry.stallIsNotified) {
        entry.stallIsNotified = false;
        const sess = entry.session;
        if (sess?.ws?.readyState === 1) {
          try { sess.send({ type: 'stream_resumed', session_id: sessionId }); } catch (_) {}
        }
      }
      this._sendRtp(entry, sessionId, frame.packets, 'output');
    });
    entry.pacer.setEnabled(false);

    emitter.on('codecParamsReady', () => {
      markFlag(entry.gate, 'codecParamsReady', true, 'codec_params_ready_event');
      this._tryCompleteStartup(sessionId, 'codec_params_ready').catch((err) => {
        logger.error('Startup failed on codec_params_ready', { sessionId, error: err.message });
      });
    });

    // streamProcessor.js emits BOTH 'frame' and 'keyframe' for IDR access units.
    // The frame object is the same instance; subscribing to both would call
    // deliverFrame() twice for every keyframe (pacer drops the dupe but still
    // counts it, and any non-pacer path would risk double-sending the IDR).
    emitter.on('frame', (frame) => entry.deliverFrame(frame));

    emitter.on('sceneCut', () => {
      if (session.ws?.readyState === 1) {
        session.send({ type: 'scene_cut', session_id: sessionId });
      }
    });

    emitter.on('firstFrame', () => {
      entry.firstFrameEmittedAt = Date.now();
      const st = getProcessorState(entry);
      const startupTimeMs = entry.gateOpenAt
        ? entry.firstFrameEmittedAt - entry.gateOpenAt
        : null;
      const totalStartMs = entry.firstFrameEmittedAt - entry.streamStartAt;
      logger.info('First IDR access unit emitted', {
        sessionId,
        captureProvider: entry.capture?.providerId ?? 'unknown',
        startupTimeMs,
        totalStartMs,
        gate: snapshot(gate),
        paramSetsRtpSent: st?.paramSetsRtpSent,
        spsBytes: st?.sps?.length,
        ppsBytes: st?.pps?.length
      });
    });

    this._wireCaptureEvents(entry, capture, sessionId, state, ctx);

    this._sessions.set(sessionId, entry);
    // Legacy adb-screenrecord capture objects expose injectInput() directly.
    // Registry-based providers (scrcpy) use PlatformHost control binding — skip here.
    if (typeof capture.injectInput === 'function') {
      controlRouter.registerRuntime(sessionId, capture);
    }

    if (supervised) {
      // Supervisor already started + verified the capture. Adopt it atomically
      // (no await before this point): detach the supervisor's buffer listener
      // and replay the frames captured during verification into the pipeline.
      capture.removeListener('data', supervised.bufferListener);
      entry.streamMeta = supervised.streamMeta || entry.streamMeta;
      for (const chunk of supervised.bufferedChunks) {
        this._ingestChunk(state, ctx, sessionId, chunk);
      }
      logger.info('Supervised capture adopted', {
        sessionId,
        captureProvider: captureProviderId,
        replayedChunks: supervised.bufferedChunks.length
      });
    } else {
      const startResult = await capture.start().catch((err) => {
        logger.error('Capture start failed', { sessionId, error: err.message });
        return { success: false, error: err.message };
      });
      if (startResult?.success === false) {
        await this.stopStream(sessionId);
        return {
          success: false,
          error: startResult.error || 'Capture failed to start'
        };
      }
    }
    logger.info('Capture parse-only until startup gate opens', { sessionId, deviceId });

    if (entry.captureEndedHandled) {
      logger.warn('Capture ended during start — aborting startStream', {
        sessionId,
        captureProvider: captureProviderId
      });
      return { success: false, error: 'Capture failed to start — see stream_error for details' };
    }

    const offerResult = await peerConnectionManager.createOffer(sessionId);
    if (!offerResult.success) {
      await this.stopStream(sessionId);
      return { success: false, error: offerResult.error };
    }

    // Guard against the race where capture.start() fails fast (e.g. scrcpy
    // socket_end during offer creation), _handleCaptureEnded fires and removes
    // the session, but createOffer() has already returned an offer.  Without
    // this check the server sends stream_started with a valid offer, the client
    // sends webrtc_answer, and handleAnswer() returns "no active stream".
    if (entry.captureEndedHandled) {
      logger.warn('Capture ended before offer was delivered — aborting startStream', {
        sessionId,
        captureProvider: captureProviderId
      });
      return { success: false, error: 'Capture failed to start — see stream_error for details' };
    }

    markFlag(gate, 'sdpLocalReady', true, 'offer_created');
    const sendParams = peerConnectionManager.getVideoSendParams(sessionId);
    if (sendParams) packetizer.configure(sendParams);

    const streamMeta = await buildStreamMeta(handle, capture, captureProviderId);
    entry.streamMeta = streamMeta;
    entry.timeline.emit('webrtc.offer_ready', { provider: captureProviderId });

    return {
      success: true,
      offer: offerResult.offer,
      captureProvider: captureProviderId,
      streamMeta
    };
  }

  async handleAnswer(sessionId, answer) {
    const entry = this._sessions.get(sessionId);
    if (!entry) {
      return { success: false, error: 'No stream session' };
    }

    const result = await peerConnectionManager.handleAnswer(sessionId, answer);
    if (!result.success) return result;

    markFlag(entry.gate, 'sdpRemoteReady', true, 'answer_received');
    const sendParams = peerConnectionManager.getVideoSendParams(sessionId);
    if (sendParams) entry.packetizer.configure(sendParams);

    peerConnectionManager.requestPipelineStart(sessionId);
    return result;
  }

  async addIceCandidate(sessionId, candidate) {
    return peerConnectionManager.addIceCandidate(sessionId, candidate);
  }

  _startPipeline(sessionId) {
    const entry = this._sessions.get(sessionId);
    if (!entry || entry.pipelineStarted) {
      return { success: false, error: entry ? 'Pipeline already started' : 'No stream session' };
    }

    entry.pipelineStarted = true;

    const run = async () => {
      try {
        const dtlsOk = await peerConnectionManager.waitForMediaReady(sessionId, 15000);
        if (!dtlsOk) {
          logger.warn('DTLS not ready in 15s — gate stays closed', { sessionId });
        } else {
          markFlag(entry.gate, 'dtlsReady', true, 'pipeline_dtls_ready');
        }

        const codecOk = await this._waitForCodecParams(entry, sessionId);
        if (!codecOk) {
          logger.warn('Proceeding without codec params — gate may not open', { sessionId });
        }

        await this._tryCompleteStartup(sessionId, 'pipeline_start');

        logger.info('Pipeline startup finished', {
          sessionId,
          gate: snapshot(entry.gate),
          pacerEnabled: entry.pacer.isEnabled(),
          captureBytes: entry.capture.getStatus()?.stats?.bytes ?? 0
        });

        setTimeout(() => {
          if ((peerConnectionManager.getStats(sessionId)?.framesSent ?? 0) === 0) {
            logger.warn('No RTP 3s after pipeline start', {
              sessionId,
              gate: snapshot(entry.gate),
              h264: entry.ctx.stats,
              captureBytes: entry.capture.getStatus()?.stats?.bytes ?? 0
            });
          }
        }, 3000);
      } catch (err) {
        logger.error('Pipeline run failed', { sessionId, error: err.message, stack: err.stack });
      }
    };

    if (entry.capture.getStatus().running) {
      run().catch((err) => logger.error('Pipeline run rejected', { sessionId, error: err.message }));
    } else {
      entry.capture.start().then(run).catch((err) => {
        logger.error('Capture start failed in pipeline', { sessionId, error: err.message });
      });
    }

    return { success: true };
  }

  /**
   * Force the capture encoder to emit an IDR on its next frame. Used on
   * renegotiation / late subscriber so the decoder can sync without a full
   * session rebuild. No-op for captures that don't support it.
   */
  requestKeyframe(sessionId) {
    const entry = this._sessions.get(sessionId);
    if (!entry) return { success: false, error: 'No stream session' };
    if (typeof entry.capture.requestKeyframe === 'function') {
      entry.capture.requestKeyframe();
      return { success: true };
    }
    return { success: false, error: 'capture does not support forced keyframe' };
  }

  getStats(sessionId) {
    const entry = this._sessions.get(sessionId);
    if (!entry) return null;
    return {
      capture: entry.capture.getStatus(),
      pacer: entry.pacer.stats,
      h264: entry.ctx.stats,
      peer: peerConnectionManager.getStats(sessionId),
      gate: snapshot(entry.gate)
    };
  }

  async stopStream(sessionId) {
    const entry = this._sessions.get(sessionId);
    if (entry) {
      // Emit a final session summary for A/B provider comparison before teardown.
      try {
        const pacer = entry.pacer.stats;
        const h264 = entry.ctx.stats;
        const captureStatus = entry.capture.getStatus() || {};
        const captureStats = captureStatus.stats || {};
        const peer = peerConnectionManager.getStats(sessionId) || {};
        const sessionDurationMs = Date.now() - entry.streamStartAt;
        const sent = pacer.sent || 0;
        const overallFps = sessionDurationMs > 0
          ? Math.round((sent / sessionDurationMs) * 1000 * 10) / 10
          : 0;

        logger.info('Session summary (A/B comparison)', {
          sessionId,
          captureProvider: entry.capture?.providerId ?? captureStatus.mode ?? 'unknown',
          sessionDurationMs,
          totalStartMs: entry.firstFrameEmittedAt
            ? entry.firstFrameEmittedAt - entry.streamStartAt
            : null,
          startupTimeMs: (entry.gateOpenAt && entry.firstFrameEmittedAt)
            ? entry.firstFrameEmittedAt - entry.gateOpenAt
            : null,
          sent,
          idrSent: h264.keyframesWithSpsPps || 0,
          pSent: Math.max(0, sent - (h264.keyframesWithSpsPps || 0)),
          overallFps,
          droppedAtIdr: pacer.droppedAtIdr || 0,
          discardedPreGateFrames: h264.discardedPreGateFrames || 0,
          captureStallRecoveries: h264.captureStallRecoveries || 0,
          ffmpegStderrErrors: captureStats.ffmpegStderrErrors || 0,
          captureBytes: captureStats.bytes || 0,
          rtpFrames: peer.framesSent || 0,
          rtpPackets: peer.packetsSent || 0,
          spsInfo: getProcessorState(entry)?.spsInfo ?? null
        });
      } catch (_) { /* non-fatal — best-effort summary */ }

      if (entry.drainTimer) {
        clearInterval(entry.drainTimer);
        entry.drainTimer = null;
      }
      if (entry.decoderWarmupTimer) {
        clearTimeout(entry.decoderWarmupTimer);
        entry.decoderWarmupTimer = null;
      }
      if (entry.paramRefreshTimer) {
        clearInterval(entry.paramRefreshTimer);
        entry.paramRefreshTimer = null;
      }
      if (entry.heartbeatTimer) {
        clearInterval(entry.heartbeatTimer);
        entry.heartbeatTimer = null;
      }
      if (entry.stallNotifyTimer) {
        clearInterval(entry.stallNotifyTimer);
        entry.stallNotifyTimer = null;
      }
      if (entry.ctx?.state?.reactiveDrainTimer) {
        clearTimeout(entry.ctx.state.reactiveDrainTimer);
        entry.ctx.state.reactiveDrainTimer = null;
      }
      if (entry.ctx?.state?.pendingRtpFrames) {
        entry.ctx.state.pendingRtpFrames = [];
      }
      if (entry.capture) {
        entry.capture.removeAllListeners('data');
        entry.capture.removeAllListeners('ended');
        entry.capture.removeAllListeners('recovered');
        entry.capture.removeAllListeners('error');
      }
      tickAnnexBDrain(entry.ctx);
      entry.pacer.stop();
      const stopResult = entry.capture.stop();
      if (stopResult && typeof stopResult.then === 'function') {
        await stopResult;
      }
      controlRouter.unregisterRuntime(sessionId);
      this._sessions.delete(sessionId);
    }
    peerConnectionManager.closePeer(sessionId);
    return { success: true };
  }
}

const streamManager = new StreamManager();

module.exports = { streamManager, StreamManager };
