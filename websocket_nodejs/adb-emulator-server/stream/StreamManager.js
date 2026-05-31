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
  createMediaStartupGate,
  snapshot,
  tryOpen,
  markFlag
} = require('./MediaStartupGate');
const { controlRouter } = require('../control/ControlRouter');
const { streamConfig } = require('../lib/config');
const { createLogger } = require('../lib/logger');

const logger = createLogger('STREAM_MGR');
const CODEC_WAIT_MS = parseInt(process.env.STREAM_CODEC_WAIT_MS, 10) || 30000;
const DECODER_WARMUP_MS = clampInt(parseInt(process.env.STREAM_DECODER_WARMUP_MS, 10), 500, 100, 2000);

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

    entry.rtpSendEnabled = true;
    ctx.options.emitRtp = true;
    entry.pacer.setEnabled(true);

    const flushed = enableRtpEmit(ctx);
    for (const frame of flushed) {
      entry.deliverFrame(frame);
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
      const pacer = entry.pacer.stats;
      const h264 = entry.ctx.stats;
      const peer = peerConnectionManager.getStats(sessionId) || {};
      const capture = entry.capture.getStatus()?.stats || {};
      const idr = h264.keyframesWithSpsPps || 0;
      const sent = pacer.sent || 0;

      logger.info('Frame send heartbeat', {
        sessionId,
        sent,
        idrSent: idr,
        pSent: Math.max(0, sent - idr),
        droppedAtIdr: pacer.droppedAtIdr || 0,
        droppedNoIdrFallback: pacer.droppedNoIdrFallback || 0,
        idleRepeats: pacer.idleRepeats || 0,
        sendMode: pacer.mode || 'immediate',
        queueDepth: pacer.queueDepth || 0,
        queueDepthPeak: pacer.queueDepthPeak || 0,
        maxDrainPerTick: pacer.maxDrainPerTick || 0,
        pacerFps: pacer.fps || 0,
        pacerQueueCap: pacer.queueCap || 0,
        lastDropReason: pacer.lastDropReason || null,
        captureStallRecoveries: h264.captureStallRecoveries || 0,
        stalePartialDiscarded: h264.stalePartialDiscarded || 0,
        partialPFrameRetained: h264.partialPFrameRetained || 0,
        idlePFrameDrain: h264.idlePFrameDrain || 0,
        deferredIdrNoParams: h264.deferredIdrNoParams || 0,
        framesEmitted: h264.framesEmitted || 0,
        keyframesWithSpsPps: h264.keyframesWithSpsPps || 0,
        chunksReceived: h264.chunksReceived || 0,
        chunksAboveDrainGate: h264.chunksAboveDrainGate || 0,
        maxChunkGapMs: h264.maxChunkGapMs || 0,
        maxChunkBytes: h264.maxChunkBytes || 0,
        captureBytes: capture.bytes || 0,
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
    if (session?.ws?.readyState === 1) {
      try {
        session.send({
          type: 'stream_error',
          session_id: sessionId,
          fatal: true,
          reason: info?.reason || 'capture_ended',
          error: `screenrecord ended (${info?.reason || 'unknown'}). Reconnect required.`
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
      this.stopStream(sessionId);
    }

    const peerResult = peerConnectionManager.createPeer(sessionId);
    if (!peerResult.success) {
      return { success: false, error: peerResult.error };
    }

    peerConnectionManager.attachPeer(sessionId, session);

    const fps = options.fps || streamConfig.fps;
    const capture = createCapture(deviceId, {
      width: options.width || streamConfig.width,
      height: options.height || streamConfig.height,
      bitRate: options.bitRate || streamConfig.recordBitrate,
      fps
    });

    const packetizer = new H264RtpPacketizer();
    const emitter = new EventEmitter();
    const stats = { bytesIn: 0, nalsParsed: 0, framesEmitted: 0 };
    const state = createStreamProcessorState({ format: 'annexb' });
    const keyframesOnly = options.keyframesOnly ?? streamConfig.keyframesOnly;
    const ctx = { emitter, packetizer, stats, options: { fps, keyframesOnly, emitRtp: false }, state };
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
      captureEndedHandled: false
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

    entry.pacer = new OutputPacer(fps, (frame) => {
      this._sendRtp(entry, sessionId, frame.packets, 'output');
    }, { idleFill: false });
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
      const st = getProcessorState(entry);
      logger.info('First IDR access unit emitted', {
        sessionId,
        gate: snapshot(gate),
        paramSetsRtpSent: st?.paramSetsRtpSent,
        spsBytes: st?.sps?.length,
        ppsBytes: st?.pps?.length
      });
    });

    capture.on('data', (chunk) => {
      if (!state.formatDetected && chunk.length > 0) {
        state.format = detectH264Format(chunk);
        state.formatDetected = true;
        logger.info('H.264 format detected', { sessionId, format: state.format });
      }
      processH264Chunk(ctx, chunk);
    });

    // Single-shot capture policy: any capture termination (clean exit, crash,
    // device disconnect, spawn failure) is fatal for this session. No
    // segmentRestart / partial-restart path exists anymore.
    capture.on('ended', (info) => {
      this._handleCaptureEnded(sessionId, info);
    });

    capture.on('error', (err) => {
      logger.error('Capture error — treating as fatal', { sessionId, error: err.message });
      this._handleCaptureEnded(sessionId, { reason: 'capture_error', error: err.message });
    });

    this._sessions.set(sessionId, entry);
    controlRouter.registerRuntime(sessionId, capture);

    capture
      .start()
      .then(() => logger.info('Capture parse-only until startup gate opens', { sessionId, deviceId }))
      .catch((err) => logger.error('Capture start failed', { sessionId, error: err.message }));

    const offerResult = await peerConnectionManager.createOffer(sessionId);
    if (!offerResult.success) {
      this.stopStream(sessionId);
      return { success: false, error: offerResult.error };
    }

    markFlag(gate, 'sdpLocalReady', true, 'offer_created');
    const sendParams = peerConnectionManager.getVideoSendParams(sessionId);
    if (sendParams) packetizer.configure(sendParams);

    return {
      success: true,
      offer: offerResult.offer,
      mode: 'server_webrtc_screenrecord'
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
          captureBytes: entry.capture.getStatus().stats.bytes
        });

        setTimeout(() => {
          if ((peerConnectionManager.getStats(sessionId)?.framesSent ?? 0) === 0) {
            logger.warn('No RTP 3s after pipeline start', {
              sessionId,
              gate: snapshot(entry.gate),
              h264: entry.ctx.stats,
              captureBytes: entry.capture.getStatus().stats.bytes
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

  stopStream(sessionId) {
    const entry = this._sessions.get(sessionId);
    if (entry) {
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
      tickAnnexBDrain(entry.ctx);
      entry.pacer.stop();
      entry.capture.stop();
      controlRouter.unregisterRuntime(sessionId);
      this._sessions.delete(sessionId);
    }
    peerConnectionManager.closePeer(sessionId);
    return { success: true };
  }
}

const streamManager = new StreamManager();

module.exports = { streamManager, StreamManager };
