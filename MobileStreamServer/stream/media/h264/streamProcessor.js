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
 * Latency-vs-safety drain for trailing P-frame NALs — PRE-GATE (raw pipe).
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
 * Reduced idle threshold for trailing P-frame drain when the media gate is
 * OPEN (emitRtp = true) — i.e. data comes from FFmpeg re-encoded stdout.
 *
 * WHY DIFFERENT FROM PFRAME_DRAIN_IDLE_MS
 * ────────────────────────────────────────
 * Pre-gate raw capture data (adb direct pipe): chunks are OS-split at
 * arbitrary boundaries.  A 30 ms quiet window is needed to be confident that
 * all in-flight bytes for the same NAL have landed.
 *
 * Post-gate FFmpeg re-encoded output: FFmpeg calls avio_flush() after every
 * encoded packet, writing each complete NAL in one atomic burst.  The only
 * in-flight gap that matters is the FFmpeg internal buffer drain (~< 1 ms
 * on loopback).  5 ms is a generous safe margin.
 *
 * WITHOUT this reduced threshold, the 50 ms drainTimer fires ~14 ms after
 * the latest P-frame chunk at 28 fps (frame period ≈ 36 ms).  14 ms <
 * 30 ms → the check returns "not ready" and increments partialPFrameRetained.
 * Over a 90-second session this produces ~1 600 spurious increments — giving
 * the false impression of a memory leak.  With 5 ms the drain succeeds at
 * every timer tick and partialPFrameRetained stays near zero.
 *
 * Override with STREAM_PFRAME_GATED_DRAIN_IDLE_MS.
 */
const PFRAME_DRAIN_IDLE_MS_GATED = clampInt(
  parseInt(process.env.STREAM_PFRAME_GATED_DRAIN_IDLE_MS, 10),
  5,
  1,
  100
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

function stallRecoveryMs(_ctx) {
  return STALL_RECOVERY_MS;
}

/**
 * Pipe read buffer full-size threshold.
 *
 * When the capture process (e.g. adb screenrecord) writes a single large
 * NAL to stdout, the OS splits the write into consecutive pipe-buffer-sized
 * reads.  On macOS / Linux the default pipe buffer capacity observed with
 * adb screenrecord is 8 KiB.  If the most recently received chunk is AT OR ABOVE this
 * size, the pipe was at capacity — the encoder almost certainly has more
 * bytes pending for the same NAL unit.
 *
 * Draining the trailing Annex-B buffer while the most recent chunk was
 * full-sized would cut the NAL mid-payload and feed FFmpeg a structurally
 * broken H.264 slice.  For long-GOP High Profile streams this corrupts the Decoded Picture Buffer (DPB), causing every
 * subsequent P-frame that references the truncated picture to appear blurry
 * until the next IDR resets the decoder — often a multi-second artifact.
 *
 * Default 8000 bytes — just below the common 8 KiB pipe-read boundary.
 * Override with STREAM_PFRAME_CHUNK_FULL_BYTES if your capture pipeline
 * uses a different internal write size.
 */
const PFRAME_DRAIN_CHUNK_FULL_BYTES = clampInt(
  parseInt(process.env.STREAM_PFRAME_CHUNK_FULL_BYTES, 10),
  8000,
  1024,
  65536
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

// Pre-allocated search patterns — avoids per-call Buffer allocation.
// Both 4-byte (00 00 00 01) and 3-byte (00 00 01) start codes are matched
// with the 3-byte pattern: every 4-byte SC contains 00 00 01 at offset +1,
// so a single Buffer.indexOf(SC3) hit covers both variants.  If needed, the
// caller can disambiguate by checking the byte before the match position.
const _SC3 = Buffer.from([0x00, 0x00, 0x01]);

/**
 * Returns true if a valid Annex-B start code exists anywhere after `afterPos`.
 *
 * Replaces the previous implementation that called findStartCodes(buffer)
 * (which walked the entire buffer and allocated an array of {index} objects)
 * just to answer a yes/no question.  Buffer.indexOf is a native C loop and
 * is typically 10–50× faster on 4–64 KB NAL buffers.
 *
 * @param {Buffer} buffer
 * @param {number} afterPos  Exclusive lower bound — only positions > afterPos count.
 */
function hasAnnexBStartCodeAfter(buffer, afterPos) {
  // Search for 00 00 01 starting from afterPos + 1 (exclusive).
  // Buffer.indexOf returns -1 if not found; any non-negative result means
  // there IS another start code after the requested position.
  return buffer.indexOf(_SC3, afterPos + 1) !== -1;
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
    firstLiveFrameEmitted: false,
    formatDetected: false,
    paramSetsRtpSent: false,
    pendingRtpFrames: [],
    reactiveDrainTimer: null,
    lastChunkSize: 0,
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
  // Fire exactly once on the first LIVE (post-gate) emission.  Can't use
  // state.framesOut === 1 because that counter accumulates pre-gate queued
  // frames, so it is already >> 1 by the time the gate opens.
  if (!state.firstLiveFrameEmitted) {
    state.firstLiveFrameEmitted = true;
    emitter.emit('firstFrame');
  }
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
    if (gapMs >= stallRecoveryMs(ctx)) {
      afterStall = true;
      stats.captureStallRecoveries = (stats.captureStallRecoveries || 0) + 1;
    }
  }
  stats.maxChunkBytes = Math.max(stats.maxChunkBytes || 0, chunk.length);
  state.lastChunkAt = now;
  state.lastChunkSize = chunk.length;
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
    if (ctx.options?.frameDelimited) {
      drainAnnexBAtFrameBoundary(ctx);
    } else {
      drainAnnexBRemainder(ctx);
      scheduleReactiveDrain(ctx);
    }
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
  const scLen = annexBStartCodeLen(b, 0);
  if (!scLen) return;
  if (hasAnnexBStartCodeAfter(b, scLen)) return; // splitter can already advance

  // Schedule the drain to fire just after the acceptance window for the
  // trailing NAL type so the first attempt is likely to succeed rather than
  // adding a spurious partialPFrameRetained increment and leaving the frame
  // to be picked up by the slower periodic 50 ms drainTimer.
  //
  //   IDR  → needs DRAIN_IDLE_MS (400 ms) of quiet time
  //   P    → post-gate: PFRAME_DRAIN_IDLE_MS_GATED (5 ms); FFmpeg avio_flush
  //           writes complete NALs so very short idle is safe
  //           pre-gate: PFRAME_DRAIN_IDLE_MS (30 ms); raw pipe chunks
  const trailingNalType = b.length > scLen ? (b[scLen] & 0x1f) : 0;
  const gateOpen = ctx.options?.emitRtp === true;
  const delayMs = trailingNalType === 5
    ? DRAIN_IDLE_MS
    : (gateOpen ? PFRAME_DRAIN_IDLE_MS_GATED : PFRAME_DRAIN_IDLE_MS);

  if (state.reactiveDrainTimer) clearTimeout(state.reactiveDrainTimer);
  state.reactiveDrainTimer = setTimeout(() => {
    state.reactiveDrainTimer = null;
    try { drainAnnexBRemainder(ctx); } catch { /* swallow; periodic tick is the safety net */ }
  }, delayMs);
  if (typeof state.reactiveDrainTimer.unref === 'function') {
    state.reactiveDrainTimer.unref();
  }
}

/**
 * Heuristic completeness check for a trailing P-frame NAL.
 *
 * We only release an Annex-B-trailing P-frame if ALL of:
 *   1. its size looks reasonable (>= PFRAME_DRAIN_MIN_BYTES) — below that we
 *      almost certainly only have the slice header and a couple of macroblock
 *      bits, meaning another chunk is still on its way.
 *   2. enough idle time has passed (PFRAME_DRAIN_IDLE_MS) that the capture
 *      process can be assumed done writing this NAL.
 *   3. the most recent chunk did NOT fill the OS pipe read buffer.  A chunk
 *      at or above PFRAME_DRAIN_CHUNK_FULL_BYTES means the pipe was at
 *      capacity: the encoder has more bytes pending for this NAL.  Emitting
 *      while the pipe is still full-to-brim would truncate the payload and
 *      corrupt the H.264 DPB — causing blurring that persists for the entire
 *      GOP on long-GOP encoders.
 *
 * @param {Buffer} nal
 * @param {number} idleMs   ms elapsed since the last chunk arrived
 * @param {number} lastChunkSize  byte length of the most recently received chunk
 */
function _looksLikeCompletePFrame(nal, idleMs, lastChunkSize) {
  if (!nal || nal.length < PFRAME_DRAIN_MIN_BYTES) return false;
  if (idleMs < PFRAME_DRAIN_IDLE_MS) return false;
  if ((lastChunkSize || 0) >= PFRAME_DRAIN_CHUNK_FULL_BYTES) return false;
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

  if (t === 7 || t === 8) {
    ingestParamSetNal(ctx, nal);
    state.buffer = Buffer.alloc(0);
    return;
  }

  if (t === 5) {
    // IDR: keep the strict size + idle gates to avoid emitting a partial IDR.
    const nalSize = nal.length;
    const minBytes = minIdrBytes(state);
    // Also block if the last chunk filled the pipe buffer — more IDR bytes are
    // almost certainly still in flight (see PFRAME_DRAIN_CHUNK_FULL_BYTES).
    const idrLastChunkFull = (state.lastChunkSize || 0) >= PFRAME_DRAIN_CHUNK_FULL_BYTES;
    // After a stall (pipe idle >= STALL_RECOVERY_MS), the pipe is definitively
    // done writing. Override the "last chunk full" safety gate — without this,
    // an IDR whose final pipe-read happened to fill the OS buffer would remain
    // stuck forever (no new start code ever arrives to end it) and the client
    // would never receive a decodeable frame for the entire session.
    const stallMs = stallRecoveryMs(ctx);
    const idrStalled = idleMs >= stallMs;
    if (nalSize < minBytes || idleMs < DRAIN_IDLE_MS || (!idrStalled && idrLastChunkFull)) return;
    if (!canEmitIdr(state)) {
      stats.deferredIdrNoParams = (stats.deferredIdrNoParams || 0) + 1;
      state.buffer = Buffer.alloc(0);
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
    // P-frame trailing in the buffer. The capture process normally emits one
    // frame per stdout burst, so after PFRAME_DRAIN_IDLE_MS of silence the
    // NAL is almost certainly complete — but only if the bytes we have look
    // like a complete slice.  Releasing a half-written NAL would feed the
    // downstream decoder a structurally broken bitstream ("Invalid level
    // prefix", full-frame concealment) and silently lose the tail bytes.
    //
    // After a long capture stall (device idle/background), relax the size
    // gate: the encoder has moved on and any tiny tail in the buffer is
    // stale garbage, not an in-flight partial slice.
    const stallMs = stallRecoveryMs(ctx);
    const stalled = idleMs >= stallMs || state.afterStall;
    const lastChunkFull = (state.lastChunkSize || 0) >= PFRAME_DRAIN_CHUNK_FULL_BYTES;

    // ── Gate-open vs pre-gate distinction ────────────────────────────────
    //
    // Pre-gate (emitRtp = false):
    //   Data comes from the raw capture source (adb) whose OS pipe
    //   chunks are arbitrary-sized.  A chunk at or above
    //   PFRAME_DRAIN_CHUNK_FULL_BYTES almost certainly means more bytes are
    //   still in flight for the same NAL — discard to prevent corrupting the
    //   DPB before the first IDR lands.
    //
    // Post-gate (emitRtp = true):
    //   Data comes from FFmpeg re-encoded stdout.  FFmpeg calls avio_flush()
    //   after every encoded packet, so each Node.js write event IS a complete
    //   NAL unit.  A chunk that happens to fill the pipe-read boundary (e.g.
    //   a P-frame that encodes to exactly 8 KB) is NOT evidence of an
    //   in-flight partial slice.  Keeping the lastChunkFull guard here causes
    //   every P-frame in that byte-size range to be permanently retained and
    //   then discarded on the 400 ms stall path — producing a frozen mirror
    //   that never updates even when the user interacts with the simulator.
    const gateOpen = ctx.options?.emitRtp === true;
    const ffmpegEncodedStream = gateOpen;

    if (stalled && nal.length < PFRAME_DRAIN_MIN_BYTES) {
      state.buffer = Buffer.alloc(0);
      stats.stalePartialDiscarded = (stats.stalePartialDiscarded || 0) + 1;
      if (state.auNals.length > 0) flushAccessUnit(ctx);
      return;
    }

    // Full-pipe-buffer stall guard — only enforced pre-gate.
    // Post-gate: FFmpeg wrote a complete NAL; do NOT discard on full-chunk.
    if (stalled && lastChunkFull && !ffmpegEncodedStream) {
      state.buffer = Buffer.alloc(0);
      state.afterStall = false;
      stats.stalePartialDiscarded = (stats.stalePartialDiscarded || 0) + 1;
      if (state.auNals.length > 0) flushAccessUnit(ctx);
      return;
    }

    if (!stalled) {
      // Post-gate: skip the lastChunkFull guard and use the reduced idle
      // threshold — FFmpeg avio_flush writes complete NALs so 5 ms quiet time
      // is sufficient to know no more bytes are coming for this NAL.
      // Pre-gate: use the original conservative check (all three conditions).
      const idleThreshold = ffmpegEncodedStream ? PFRAME_DRAIN_IDLE_MS_GATED : PFRAME_DRAIN_IDLE_MS;
      const ready = ffmpegEncodedStream
        ? (nal.length >= PFRAME_DRAIN_MIN_BYTES && idleMs >= idleThreshold)
        : _looksLikeCompletePFrame(nal, idleMs, state.lastChunkSize);
      if (!ready) {
        stats.partialPFrameRetained = (stats.partialPFrameRetained || 0) + 1;
        return;
      }
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

    // A scene_cut tells the client to drop frames buffered before a genuine
    // discontinuity (rotation / app switch). The old heuristic — "any IDR
    // larger than 8 KB" — misfires badly once we force a short keyframe
    // cadence (i-frame-interval): during video EVERY periodic IDR is large, so
    // the client flushed its render slot on every keyframe (~1×/sec), causing
    // visible stutter. A real discontinuity changes the encoder's SPS
    // (resolution/orientation), whereas routine forced keyframes re-send the
    // identical SPS. Gate scene_cut on an actual SPS change so periodic
    // keyframes never churn the renderer.
    const spsKey = state.sps ? state.sps.toString('latin1') : '';
    const spsChanged = spsKey !== '' && state.lastSceneSpsKey !== undefined &&
      spsKey !== state.lastSceneSpsKey;
    sceneCut = spsChanged && state.framesOut > 0;
    state.lastSceneSpsKey = spsKey;

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

/**
 * Drain a single trailing NAL when the upstream source delivers one complete
 * access unit per chunk (scrcpy frame packets). Pipe-idle heuristics are
 * unsafe here: at 30 fps the inter-chunk gap (~33 ms) never reaches
 * DRAIN_IDLE_MS (400 ms), so IDR-only keyframes would stay buffered forever.
 */
function drainAnnexBAtFrameBoundary(ctx) {
  const { state, stats } = ctx;
  const b = state.buffer;
  if (!b || b.length < 8) return;

  const scLen = annexBStartCodeLen(b, 0);
  if (!scLen) return;

  if (hasAnnexBStartCodeAfter(b, scLen)) {
    const reparsed = extractNals(b);
    state.buffer = reparsed.remainder;
    processParsedNals(ctx, reparsed.nals, processAnnexBNal);
    if (state.buffer.length >= 8) drainAnnexBAtFrameBoundary(ctx);
    return;
  }

  const nal = b.slice(scLen);
  const t = nalType(nal);

  if (t === 7 || t === 8) {
    ingestParamSetNal(ctx, nal);
    state.buffer = Buffer.alloc(0);
    return;
  }

  if (t === 5) {
    if (nal.length < minIdrBytes(state)) {
      stats.skippedSmallIdr = (stats.skippedSmallIdr || 0) + 1;
      state.buffer = Buffer.alloc(0);
      return;
    }
    if (!canEmitIdr(state)) {
      stats.deferredIdrNoParams = (stats.deferredIdrNoParams || 0) + 1;
      state.buffer = Buffer.alloc(0);
      return;
    }
    state.buffer = Buffer.alloc(0);
    stats.frameBoundaryIdrDrain = (stats.frameBoundaryIdrDrain || 0) + 1;
    if (state.auNals.length > 0) flushAccessUnit(ctx);
    state.auNals.push(nal);
    flushAccessUnit(ctx);
    return;
  }

  if (t === 1) {
    if (!state.gotFirstKeyframe) {
      state.buffer = Buffer.alloc(0);
      return;
    }
    state.buffer = Buffer.alloc(0);
    stats.frameBoundaryPDrain = (stats.frameBoundaryPDrain || 0) + 1;
    const mb = parseFirstMbInSlice(nal);
    if (mb === 0 && state.auNals.length > 0) flushAccessUnit(ctx);
    else if (mb === null && state.auNals.length > 0) {
      state.auNals = [];
      stats.droppedIncompleteAu = (stats.droppedIncompleteAu || 0) + 1;
    }
    state.auNals.push(nal);
    flushAccessUnit(ctx);
    return;
  }

  // SEI / AUD / other non-VCL — drop without retaining across frame boundaries.
  state.buffer = Buffer.alloc(0);
}

function tickAnnexBDrain(ctx) {
  if (ctx.state.format !== 'annexb') return;
  if (ctx.options?.frameDelimited) {
    drainAnnexBAtFrameBoundary(ctx);
  } else {
    drainAnnexBRemainder(ctx);
  }
}

/**
 * Enable real-time RTP emit and DISCARD the pre-gate buffer, EXCEPT for the
 * most recent IDR access unit (its STAP-A + IDR pair), which is emitted
 * immediately after the gate opens.
 *
 * WHY keep one IDR instead of discarding everything
 * ──────────────────────────────────────────────────
 * The original design discarded all pre-gate frames to prevent sending up to
 * ~3 s of accumulated IDRs as an instant burst that would overwhelm the
 * desktop H.264 decoder (dozens of IDRs in ~50 ms → concealment on every
 * frame). That burst-prevention safety is fully preserved here — we only
 * keep ONE final IDR, not the whole burst.
 *
 * The problem this solves: when the capture source stalls immediately after
 * startup (e.g. adb screenrecord on a static screen produces
 * 1-2 IDRs and then goes quiet), the IDR emitted just before the warmup timer
 * opens the gate is the ONLY keyframe that will ever exist for this session.
 * Discarding it leaves the client permanently frozen — the next IDR never
 * arrives because the capture source has nothing new to encode. Keeping exactly one IDR
 * eliminates this deadlock without any burst risk to the decoder.
 *
 * @returns {number} Number of frames discarded.
 */
function enableRtpEmit(ctx) {
  ctx.options.emitRtp = true;
  const { state, stats } = ctx;
  const pending = state.pendingRtpFrames || [];
  state.pendingRtpFrames = [];

  // Find the most recent IDR keyframe in the pre-gate queue.
  let lastIdrIdx = -1;
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].isKeyframe && !pending[i].isParamSetsOnly) {
      lastIdrIdx = i;
      break;
    }
  }

  // Build the "keep" list: the STAP-A immediately before the IDR (if present)
  // plus the IDR itself.  Everything else is discarded (burst prevention).
  const toEmit = [];
  if (lastIdrIdx >= 0) {
    const prev = lastIdrIdx > 0 ? pending[lastIdrIdx - 1] : null;
    if (prev && prev.isParamSetsOnly && !prev.isKeyframe) {
      toEmit.push(prev);
    }
    toEmit.push(pending[lastIdrIdx]);
  }

  const discarded = pending.length - toEmit.length;
  if (discarded > 0) {
    stats.discardedPreGateFrames = (stats.discardedPreGateFrames || 0) + discarded;
  }

  // Emit the preserved IDR (and its STAP-A) now that the gate is open.
  // We call ctx.emitter.emit('frame') directly — the same path dispatchFrame()
  // uses — but skip stats.framesEmitted++ because those were already counted
  // when the frames were first created pre-gate in flushAccessUnit().
  //
  // CRITICAL: these packets were serialized PRE-GATE, so their RTP timestamp
  // and sequence number predate the bootstrap STAP-A that StreamManager just
  // flushed at gate-open. Replaying them as-is makes the receiver see the
  // sequence/timestamp jump backwards — the jitter buffer/framer discards the
  // frame and the client never decodes a keyframe (permanent "loading").
  // Re-stamp each preserved frame with a fresh, monotonic timestamp + sequence.
  const fps = ctx.options?.fps || 20;
  const tsStep = Math.max(1, Math.floor(90000 / fps));
  for (const frame of toEmit) {
    if (ctx.packetizer && frame.packets) {
      const ts = state.nextRtpTimestamp;
      ctx.packetizer.restamp(frame.packets, ts);
      frame.timestamp = ts;
      state.nextRtpTimestamp = (state.nextRtpTimestamp + tsStep) >>> 0;
    }
    ctx.emitter.emit('frame', frame);
    if (frame.isKeyframe) {
      ctx.emitter.emit('keyframe', frame);
      stats.keyframesWithSpsPps = (stats.keyframesWithSpsPps || 0) + 1;
      if (!state.firstLiveFrameEmitted) {
        state.firstLiveFrameEmitted = true;
        ctx.emitter.emit('firstFrame');
      }
    }
  }

  return discarded;
}

module.exports = {
  processH264Chunk,
  tickAnnexBDrain,
  drainAnnexBAtFrameBoundary,
  createStreamProcessorState,
  enableRtpEmit
};
