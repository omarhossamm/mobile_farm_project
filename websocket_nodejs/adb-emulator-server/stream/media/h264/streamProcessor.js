/**
 * H.264 Annex-B / AVCC → RTP.
 * Enforces SPS → PPS → IDR, in-band STAP-A before IDR, no RTP emit until emitRtp is true.
 */

const { extractNals, findStartCodes, nalType } = require('./h264AnnexBParser');
const {
  initParamSetState,
  storeParamSetNal,
  canEmitIdr,
  getParamSetNals,
  onParamSetUpdated
} = require('./paramSetCache');

const DEFAULT_MIN_IDR_BYTES = parseInt(process.env.STREAM_MIN_IDR_BYTES, 10) || 8192;
const FIRST_IDR_MIN_BYTES = parseInt(process.env.STREAM_FIRST_IDR_MIN_BYTES, 10) || 2048;
const DRAIN_IDLE_MS = parseInt(process.env.STREAM_DRAIN_IDLE_MS, 10) || 400;

/**
 * Latency-vs-safety drain for trailing P-frame NALs.
 *
 * The Annex-B splitter cannot tell that a NAL is complete until it sees the
 * NEXT start code. Without any drain, a single trailing P-frame would wait
 * for the next captured frame to arrive (≈ one inter-frame interval, ~50 ms
 * at 20 fps), adding a full frame of mirror latency.
 *
 * SAFETY OVER LATENCY: the previous default (5 ms) was unsafe. `adb exec-out`
 * routinely chunks a single screenrecord write across several Node.js `data`
 * events; macOS scheduler jitter alone can stretch the inter-chunk gap past
 * 5 ms. When that happens the old drain truncated the partial NAL, fed a
 * malformed slice to the decoder, and silently lost the tail bytes — which
 * reproduces exactly as ``Invalid level prefix'' / ``concealing N MBs in P
 * frame'' errors and the visible block corruption we kept hitting.
 *
 * The new default (30 ms) is well above any realistic ADB inter-chunk gap on
 * loopback / LAN, while still strictly below one inter-frame interval at
 * 20 fps (50 ms). Override with STREAM_PFRAME_DRAIN_IDLE_MS only if you have
 * measured your own ADB pipeline and know the chunk gap distribution.
 *
 * In addition to the time gate, the drain now requires the buffer to look
 * like a complete NAL (a minimum size heuristic) before discarding it — see
 * `_looksLikeCompletePFrame` below.
 */
const PFRAME_DRAIN_IDLE_MS = clampInt(
  parseInt(process.env.STREAM_PFRAME_DRAIN_IDLE_MS, 10),
  30,
  5,
  500
);

/**
 * Minimum size we accept for an eagerly-drained trailing P-frame. Below this
 * we keep the bytes in the buffer and wait for either more chunks (which will
 * complete the NAL) or the next start code (which guarantees completeness).
 *
 * 32 bytes is well below any realistic non-skip slice, and well above the
 * smallest slice-header-only payload screenrecord ever emits during long
 * stretches of static video.
 */
const PFRAME_DRAIN_MIN_BYTES = clampInt(
  parseInt(process.env.STREAM_PFRAME_DRAIN_MIN_BYTES, 10),
  32,
  16,
  4096
);

/**
 * After this many ms without a capture chunk, the next arrival is treated as
 * a fresh burst (screenrecord went quiet while the device was idle/background).
 * Trailing P-frame bytes in the Annex-B buffer are then drained with relaxed
 * completeness rules so the mirror does not stay frozen until the NEXT burst.
 */
const STALL_RECOVERY_MS = clampInt(
  parseInt(process.env.STREAM_STALL_RECOVERY_MS, 10),
  400,
  100,
  5000
);

function clampInt(value, fallback, lo, hi) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(hi, Math.max(lo, value));
}

function minIdrBytes(state) {
  return state.gotFirstKeyframe ? DEFAULT_MIN_IDR_BYTES : FIRST_IDR_MIN_BYTES;
}

function annexBStartCodeLen(buffer, pos = 0) {
  if (buffer.length >= pos + 4 &&
    buffer[pos] === 0 && buffer[pos + 1] === 0 && buffer[pos + 2] === 0 && buffer[pos + 3] === 1) {
    return 4;
  }
  if (buffer.length >= pos + 3 &&
    buffer[pos] === 0 && buffer[pos + 1] === 0 && buffer[pos + 2] === 1) {
    return 3;
  }
  return 0;
}

function hasAnnexBStartCodeAfter(buffer, afterPos) {
  const starts = findStartCodes(buffer);
  return starts.some((s) => s.index > afterPos);
}

const { extractAvccNals } = require('./h264AvccParser');
const { parseFirstMbInSlice } = require('./h264SliceHeader');
const { appendChunk, flushToBuffer } = require('./appendBuffer');

function createStreamProcessorState(overrides = {}) {
  const state = {
    format: 'annexb',
    buffer: Buffer.alloc(0),
    auNals: [],
    gotFirstKeyframe: false,
    lastKeyframeEmitAt: 0,
    nextRtpTimestamp: (Math.floor(Math.random() * 0x7fffffff) >>> 0),
    framesOut: 0,
    formatDetected: false,
    paramSetsRtpSent: false,
    pendingRtpFrames: [],
    reactiveDrainTimer: null,
    ...overrides
  };
  initParamSetState(state);
  return state;
}

function isEmitRtpEnabled(ctx) {
  return ctx.options?.emitRtp === true;
}

/** RFC 6184 STAP-A — NAL type 24 in first payload byte. */
function isStapAPacket(rtpBuf) {
  return rtpBuf && rtpBuf.length > 13 && (rtpBuf[12] & 0x1f) === 24;
}

function queueRtpFrame(ctx, frame) {
  const { state, stats } = ctx;
  if (!state.pendingRtpFrames) state.pendingRtpFrames = [];
  state.pendingRtpFrames.push(frame);
  stats.queuedPreReady = (stats.queuedPreReady || 0) + 1;
}

function dispatchFrame(ctx, frame, opts = {}) {
  const { emitter, state, stats } = ctx;
  if (!isEmitRtpEnabled(ctx)) {
    queueRtpFrame(ctx, frame);
    return;
  }

  emitter.emit('frame', frame);
  if (frame.isKeyframe) {
    emitter.emit('keyframe', frame);
    if (opts.sceneCut) emitter.emit('sceneCut', frame);
    stats.keyframesWithSpsPps = (stats.keyframesWithSpsPps || 0) + 1;
  }
  if (state.framesOut === 1) emitter.emit('firstFrame');
}

/**
 * Take frames queued while waiting for SDP/DTLS (caller delivers in order).
 * @returns {object[]}
 */
function flushPendingRtpFrames(ctx) {
  const { state } = ctx;
  const pending = state.pendingRtpFrames || [];
  state.pendingRtpFrames = [];
  return pending;
}

/**
 * Bootstrap STAP-A (SPS+PPS only) — queued until emitRtp unless sent by StreamManager.
 */
function tryEmitParamSetsBootstrap(ctx) {
  const { emitter, packetizer, stats, state } = ctx;
  if (state.paramSetsRtpSent || !onParamSetUpdated(state)) return;

  const paramNals = getParamSetNals(state);
  const rtpTimestamp = state.nextRtpTimestamp;
  const packets = packetizer.packetizeStapA(paramNals, rtpTimestamp, true);
  if (!packets.length) return;

  stats.paramSetsBootstrapBuilt = (stats.paramSetsBootstrapBuilt || 0) + 1;

  const bootstrap = {
    packets,
    timestamp: rtpTimestamp,
    isKeyframe: false,
    hasSpsPps: true,
    isParamSetsOnly: true,
    spsBytes: state.sps.length,
    ppsBytes: state.pps.length
  };

  if (!isEmitRtpEnabled(ctx)) {
    queueRtpFrame(ctx, bootstrap);
    return;
  }

  emitter.emit('paramSets', bootstrap);
}

function ingestParamSetNal(ctx, nal) {
  const t = nalType(nal);
  if (t !== 7 && t !== 8) return;

  const kind = storeParamSetNal(ctx.state, nal);
  if (!kind) return;

  const { stats, state } = ctx;
  if (kind === 'sps') stats.spsCached = (stats.spsCached || 0) + 1;
  if (kind === 'pps') stats.ppsCached = (stats.ppsCached || 0) + 1;

  if (onParamSetUpdated(state)) {
    ctx.emitter.emit('codecParamsReady', {
      spsBytes: state.sps.length,
      ppsBytes: state.pps.length
    });
  }
}

/** Process SPS/PPS NALs before any VCL NAL in the same parse batch. */
function processParsedNals(ctx, nals, handler) {
  const spsList = [];
  const ppsList = [];
  const vclList = [];

  for (const nal of nals) {
    const t = nalType(nal);
    if (t === 7) spsList.push(nal);
    else if (t === 8) ppsList.push(nal);
    else vclList.push(nal);
  }

  for (const nal of spsList) handler(ctx, nal);
  for (const nal of ppsList) handler(ctx, nal);
  for (const nal of vclList) handler(ctx, nal);
}

function processH264Chunk(ctx, chunk) {
  const { stats, state } = ctx;
  if (!chunk || chunk.length === 0) return;

  if (!state.auNals) state.auNals = [];
  if (state.gotFirstKeyframe == null) state.gotFirstKeyframe = false;
  if (state.lastKeyframeEmitAt == null) state.lastKeyframeEmitAt = 0;
  if (!state.receivedSps && !state.receivedPps) initParamSetState(state);

  stats.bytesIn += chunk.length;

  // Chunk-arrival telemetry — surface ADB transport jitter that used to be
  // invisible. The reactive drain depends on the inter-chunk gap being
  // dramatically shorter than PFRAME_DRAIN_IDLE_MS; if these histograms
  // show otherwise, raise the threshold or disable reactive drain entirely.
  const now = Date.now();
  let afterStall = false;
  if (state.lastChunkAt) {
    const gapMs = now - state.lastChunkAt;
    stats.chunksReceived = (stats.chunksReceived || 0) + 1;
    stats.maxChunkGapMs = Math.max(stats.maxChunkGapMs || 0, gapMs);
    if (gapMs >= PFRAME_DRAIN_IDLE_MS) {
      stats.chunksAboveDrainGate = (stats.chunksAboveDrainGate || 0) + 1;
    }
    if (gapMs >= STALL_RECOVERY_MS) {
      afterStall = true;
      stats.captureStallRecoveries = (stats.captureStallRecoveries || 0) + 1;
    }
  }
  stats.maxChunkBytes = Math.max(stats.maxChunkBytes || 0, chunk.length);
  state.lastChunkAt = now;
  state.afterStall = afterStall;

  appendChunk(state, chunk);
  flushToBuffer(state);

  const parsed = state.format === 'avcc'
    ? extractAvccNals(state.buffer)
    : extractNals(state.buffer);

  state.buffer = parsed.remainder;

  for (const nal of parsed.nals) stats.nalsParsed++;

  if (state.format === 'annexb') {
    processParsedNals(ctx, parsed.nals, processAnnexBNal);
  } else {
    processParsedNals(ctx, parsed.nals, processAvccNal);
  }

  if (state.format === 'avcc' && state.auNals.length > 0) {
    flushAccessUnit(ctx);
  }

  if (state.format === 'annexb') {
    drainAnnexBRemainder(ctx);
    scheduleReactiveDrain(ctx);
  }
}

/**
 * Latency-sensitive: when this chunk leaves a single trailing NAL in the
 * buffer, the periodic StreamManager tick (~100 ms default) may be up to one
 * full tick away. A debounced `setTimeout` makes the next drain attempt fire
 * exactly `PFRAME_DRAIN_IDLE_MS` after the most recent chunk — i.e. the
 * earliest moment the idle gate inside `drainAnnexBRemainder` is willing to
 * release the trailing P-frame. Each new chunk resets the timer, so we never
 * fire while the encoder is still streaming data into the same NAL.
 *
 * The actual drain decision (release vs. wait) lives in `drainAnnexBRemainder`
 * and is double-gated by both the idle threshold AND a "looks complete" size
 * check — see `_looksLikeCompletePFrame`.
 */
function scheduleReactiveDrain(ctx) {
  const { state } = ctx;
  const b = state.buffer;
  if (!b || b.length < 8) return;
  if (!annexBStartCodeLen(b, 0)) return;
  if (hasAnnexBStartCodeAfter(b, 1)) return; // splitter can already advance

  if (state.reactiveDrainTimer) clearTimeout(state.reactiveDrainTimer);
  state.reactiveDrainTimer = setTimeout(() => {
    state.reactiveDrainTimer = null;
    try { drainAnnexBRemainder(ctx); } catch { /* swallow; periodic tick is the safety net */ }
  }, PFRAME_DRAIN_IDLE_MS);
  if (typeof state.reactiveDrainTimer.unref === 'function') {
    state.reactiveDrainTimer.unref();
  }
}

/**
 * Heuristic completeness check for a trailing P-frame NAL.
 *
 * We only release an Annex-B-trailing P-frame if BOTH:
 *   1. its size looks reasonable (>= PFRAME_DRAIN_MIN_BYTES) — below that we
 *      almost certainly only have the slice header and a couple of macroblock
 *      bits, which means another chunk is still on its way.
 *   2. enough idle time has passed (PFRAME_DRAIN_IDLE_MS) that screenrecord
 *      can be assumed done writing this NAL.
 *
 * Either guard alone is insufficient: a tiny NAL is suspicious regardless of
 * how long we wait (could be a partial header), and a large NAL is still
 * worth waiting on if the most recent chunk landed within the burst window.
 */
function _looksLikeCompletePFrame(nal, idleMs) {
  if (!nal || nal.length < PFRAME_DRAIN_MIN_BYTES) return false;
  if (idleMs < PFRAME_DRAIN_IDLE_MS) return false;
  return true;
}

function processAvccNal(ctx, nal) {
  const { state } = ctx;
  const t = nalType(nal);
  if (t === 6 || t === 9) return;
  if (t === 7 || t === 8) {
    ingestParamSetNal(ctx, nal);
    return;
  }
  if (t !== 1 && t !== 5) return;

  if (t === 5) {
    if (!canEmitIdr(state)) {
      ctx.stats.deferredIdrNoParams = (ctx.stats.deferredIdrNoParams || 0) + 1;
      return;
    }
    if (state.auNals.length > 0) flushAccessUnit(ctx);
    state.auNals.push(nal);
    flushAccessUnit(ctx);
    return;
  }

  if (!state.gotFirstKeyframe) return;
  if (state.auNals.length > 0) flushAccessUnit(ctx);
  state.auNals.push(nal);
}

function drainAnnexBRemainder(ctx) {
  const { state, stats } = ctx;
  const b = state.buffer;
  if (!b || b.length < 8) return;

  const scLen = annexBStartCodeLen(b, 0);
  if (!scLen) return;

  // Two or more start codes in the buffer — the normal splitter can advance.
  if (hasAnnexBStartCodeAfter(b, scLen)) {
    const reparsed = extractNals(b);
    state.buffer = reparsed.remainder;
    processParsedNals(ctx, reparsed.nals, processAnnexBNal);
    return;
  }

  // Single trailing NAL — flush it eagerly when it has been idle long enough
  // that the next chunk is almost certainly not appending to it.
  const off = scLen;
  const nal = b.slice(off);
  const t = nalType(nal);
  const idleMs = Date.now() - (state.lastChunkAt || 0);

  if (t === 5) {
    // IDR: keep the strict size + idle gates to avoid emitting a partial IDR.
    const nalSize = nal.length;
    const minBytes = minIdrBytes(state);
    if (nalSize < minBytes || idleMs < DRAIN_IDLE_MS) return;
    if (!canEmitIdr(state)) {
      stats.deferredIdrNoParams = (stats.deferredIdrNoParams || 0) + 1;
      return;
    }

    state.buffer = Buffer.alloc(0);
    stats.idleIdrDrain = (stats.idleIdrDrain || 0) + 1;
    if (state.auNals.length > 0) flushAccessUnit(ctx);
    state.auNals.push(nal);
    flushAccessUnit(ctx);
    return;
  }

  if (t === 1 && state.gotFirstKeyframe) {
    // P-frame trailing in the buffer. screenrecord normally emits one frame
    // per stdout burst, so after PFRAME_DRAIN_IDLE_MS of silence the NAL is
    // almost certainly complete — but only if the bytes we have look like a
    // complete slice. Releasing a half-written NAL would feed FFmpeg a
    // structurally broken bitstream (``Invalid level prefix'', full-frame
    // concealment) and silently lose the tail bytes from the next chunk.
    //
    // After a long capture stall (device idle/background), relax the size
    // gate: the encoder has moved on and any tiny tail in the buffer is
    // stale garbage, not an in-flight partial slice.
    const stalled = idleMs >= STALL_RECOVERY_MS || state.afterStall;
    if (stalled && nal.length < PFRAME_DRAIN_MIN_BYTES) {
      state.buffer = Buffer.alloc(0);
      stats.stalePartialDiscarded = (stats.stalePartialDiscarded || 0) + 1;
      if (state.auNals.length > 0) flushAccessUnit(ctx);
      return;
    }
    if (!stalled && !_looksLikeCompletePFrame(nal, idleMs)) {
      stats.partialPFrameRetained = (stats.partialPFrameRetained || 0) + 1;
      return;
    }
    if (stalled && idleMs < PFRAME_DRAIN_IDLE_MS) {
      // Fresh burst just started — wait one drain tick for the NAL to finish.
      stats.partialPFrameRetained = (stats.partialPFrameRetained || 0) + 1;
      return;
    }

    state.buffer = Buffer.alloc(0);
    state.afterStall = false;
    stats.idlePFrameDrain = (stats.idlePFrameDrain || 0) + 1;
    if (state.auNals.length > 0) flushAccessUnit(ctx);
    state.auNals.push(nal);
    flushAccessUnit(ctx);
  }
}

function processAnnexBNal(ctx, nal) {
  const { stats, state } = ctx;
  const t = nalType(nal);
  if (t === 6 || t === 9) return;

  if (t === 7 || t === 8) {
    ingestParamSetNal(ctx, nal);
    return;
  }

  if (t !== 1 && t !== 5) return;
  if (t === 1 && ctx.options?.keyframesOnly) return;

  if (t === 5) {
    if (nal.length < minIdrBytes(state)) {
      stats.skippedSmallIdr = (stats.skippedSmallIdr || 0) + 1;
      return;
    }
    if (!canEmitIdr(state)) {
      stats.deferredIdrNoParams = (stats.deferredIdrNoParams || 0) + 1;
      return;
    }
    if (state.auNals.length > 0) flushAccessUnit(ctx);
    state.auNals.push(nal);
    flushAccessUnit(ctx);
    return;
  }

  if (!state.gotFirstKeyframe) return;

  const mb = parseFirstMbInSlice(nal);
  if (mb === 0 && state.auNals.length > 0) flushAccessUnit(ctx);
  else if (mb === null && state.auNals.length > 0) {
    state.auNals = [];
    stats.droppedIncompleteAu = (stats.droppedIncompleteAu || 0) + 1;
  }
  state.auNals.push(nal);
}

function flushAccessUnit(ctx) {
  const { packetizer, stats, options, state } = ctx;
  const nals = state.auNals;
  if (!nals || nals.length === 0) return;

  const vclPending = nals.filter((n) => {
    const t = nalType(n);
    return t === 1 || t === 5;
  });
  const hasIdr = vclPending.some((n) => nalType(n) === 5);

  if (hasIdr && !canEmitIdr(state)) {
    stats.deferredIdrNoParams = (stats.deferredIdrNoParams || 0) + 1;
    return;
  }

  state.auNals = [];

  const fps = options.fps || 20;
  const tsStep = Math.max(1, Math.floor(90000 / fps));
  const vclNals = [...vclPending];
  let isKeyframe = false;

  for (const nal of vclNals) {
    if (nalType(nal) === 5) isKeyframe = true;
  }

  if (vclNals.length === 0) return;

  if (isKeyframe) {
    const idrBytes = vclNals.filter((n) => nalType(n) === 5).reduce((s, n) => s + n.length, 0);
    if (idrBytes > 0 && idrBytes < minIdrBytes(state)) {
      stats.skippedSmallIdr = (stats.skippedSmallIdr || 0) + 1;
      return;
    }
    if (!canEmitIdr(state)) {
      stats.deferredIdrNoParams = (stats.deferredIdrNoParams || 0) + 1;
      return;
    }

    // Strict separation: emit STAP-A (SPS+PPS) on its OWN RTP timestamp, then
    // advance the timestamp so the IDR access unit lands on the next slot.
    // The receiver's depacketizer groups by timestamp, so this guarantees
    // SPS/PPS and the IDR are never coalesced into the same decode unit and
    // the IDR is always preceded by fresh parameter sets in the wire order.
    const paramNals = getParamSetNals(state);
    if (paramNals && paramNals.length > 0) {
      const stapTs = state.nextRtpTimestamp;
      const stapPackets = packetizer.packetizeStapA(paramNals, stapTs, true);
      if (stapPackets.length > 0) {
        dispatchFrame(ctx, {
          packets: stapPackets,
          timestamp: stapTs,
          isKeyframe: false,
          hasSpsPps: true,
          isParamSetsOnly: true,
          size: paramNals.reduce((s, n) => s + n.length, 0),
          frameNumber: state.framesOut // not advanced yet — this is a meta frame
        });
        state.nextRtpTimestamp = (state.nextRtpTimestamp + tsStep) >>> 0;
        stats.paramSetsBeforeIdr = (stats.paramSetsBeforeIdr || 0) + 1;
      }
    }
  }

  const rtpTimestamp = state.nextRtpTimestamp;
  const packets = [];

  for (let i = 0; i < vclNals.length; i++) {
    const isLast = i === vclNals.length - 1;
    packets.push(...packetizer.packetize(vclNals[i], rtpTimestamp, isLast));
  }

  if (packets.length === 0) return;

  if (isKeyframe) {
    // After the STAP-A advance, packets[0] must be IDR (single-NAL type 5) or
    // an IDR FU-A start (type 28 carrying type 5). Anything else means the
    // STAP-A and IDR got coalesced — refuse to ship.
    if (isStapAPacket(packets[0])) {
      stats.keyframeContainedStap = (stats.keyframeContainedStap || 0) + 1;
      return;
    }
    const firstNalType = packets[0].length > 13 ? (packets[0][12] & 0x1f) : -1;
    if (firstNalType !== 5 && firstNalType !== 28) {
      stats.keyframeMissingIdr = (stats.keyframeMissingIdr || 0) + 1;
      return;
    }
  }

  if (isKeyframe && state.framesOut === 0) {
    stats.lastKeyframeNalBytes = vclNals.reduce((s, n) => s + n.length, 0);
    stats.lastKeyframeRtpPackets = packets.length;
    stats.firstAuWasStandaloneIdr = true;
  }

  if (!isKeyframe && !state.gotFirstKeyframe) return;

  const idrBytes = isKeyframe
    ? vclNals.filter((n) => nalType(n) === 5).reduce((s, n) => s + n.length, 0)
    : 0;
  let sceneCut = false;

  if (isKeyframe) {
    const now = Date.now();
    const dupMs = parseInt(process.env.STREAM_IDR_DEDUP_MS, 10) || 2500;
    const isSceneIdr = idrBytes >= DEFAULT_MIN_IDR_BYTES;
    // First session keyframe is always large; do not scene_cut (would reset decoder before first picture).
    sceneCut = isSceneIdr && state.framesOut > 0;
    if (!isSceneIdr && state.lastKeyframeEmitAt && now - state.lastKeyframeEmitAt < dupMs) return;
    state.lastKeyframeEmitAt = now;
    state.gotFirstKeyframe = true;
  }

  state.framesOut++;
  stats.framesEmitted++;

  const frame = {
    packets,
    timestamp: rtpTimestamp,
    isKeyframe,
    hasSpsPps: false,
    isParamSetsOnly: false,
    size: vclNals.reduce((s, n) => s + n.length, 0),
    frameNumber: state.framesOut
  };

  dispatchFrame(ctx, frame, { sceneCut });
  state.nextRtpTimestamp = (state.nextRtpTimestamp + tsStep) >>> 0;
}

function tickAnnexBDrain(ctx) {
  if (ctx.state.format !== 'annexb') return;
  drainAnnexBRemainder(ctx);
}

function enableRtpEmit(ctx) {
  ctx.options.emitRtp = true;
  const pending = flushPendingRtpFrames(ctx);
  // The pre-gate path skips `dispatchFrame`'s keyframe counter (frames are
  // queued, not dispatched). Without this, the heartbeat shows `idrSent: 0`
  // forever — masking screenrecord's "only one IDR per session" behaviour.
  for (const f of pending) {
    if (f && f.isKeyframe) {
      ctx.stats.keyframesWithSpsPps = (ctx.stats.keyframesWithSpsPps || 0) + 1;
    }
  }
  return pending;
}

module.exports = {
  processH264Chunk,
  tickAnnexBDrain,
  createStreamProcessorState,
  enableRtpEmit
};
