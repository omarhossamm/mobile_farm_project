/**
 * Per-session SPS/PPS cache — strict SPS → PPS → IDR ordering for in-band RTP.
 *
 * State fields managed here (attached to the StreamProcessor state object):
 *   - sps, pps                Buffer | null    cached parameter set NALs
 *   - receivedSps, receivedPps                 first-seen flags
 *   - codecParamsConfirmed    bool              set once both NALs are cached
 */

const { nalType } = require('./h264AnnexBParser');
const { parseSpsInfo, maxDpbFramesForLevel } = require('./h264SpsParser');

function initParamSetState(state) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('initParamSetState: state object required');
  }
  state.sps = null;
  state.pps = null;
  state.receivedSps = false;
  state.receivedPps = false;
  state.codecParamsConfirmed = false;
}

/**
 * Idempotent — safe before any cache access.
 * @returns {object|null} same state reference, or null when state is invalid
 */
function ensureParamSetState(state) {
  if (!state || typeof state !== 'object') return null;
  if (typeof state.receivedSps !== 'boolean') {
    initParamSetState(state);
  }
  return state;
}

function storeParamSetNal(state, nal) {
  if (!ensureParamSetState(state) || !nal?.length) return null;

  const t = nalType(nal);
  if (t === 7) {
    state.sps = Buffer.from(nal);
    state.receivedSps = true;

    // Parse and cache SPS metadata for heartbeat diagnostics.  Log once per
    // session (when the value changes) rather than on every IDR.
    // re-emits the same SPS with every keyframe.
    try {
      const info = parseSpsInfo(nal);
      if (info) {
        const prev = state.spsInfo;
        const changed = !prev ||
          prev.numRefFrames !== info.numRefFrames ||
          prev.profileIdc !== info.profileIdc ||
          prev.levelIdc !== info.levelIdc;

        state.spsInfo = info;

        if (changed) {
          // Compute the spec-maximum DPB frames for this level/resolution so we
          // can warn accurately.  We don't have the resolution here, so use a
          // generous upper bound (H.264 spec hard-caps num_ref_frames at 16).
          const specMax = maxDpbFramesForLevel(info.levelIdc, 1920, 1080); // conservative
          if (info.numRefFrames > specMax) {
            // eslint-disable-next-line no-console
            console.warn(
              `[PARAM_CACHE] SPS num_ref_frames=${info.numRefFrames} exceeds ` +
              `spec max (${specMax}) for profile=${info.profileIdc} level=${info.levelIdc}. ` +
              `This may indicate a non-compliant encoder.`
            );
          } else if (info.numRefFrames > 4) {
            // High (but spec-valid) value — large DPB increases artifact persistence.
            // eslint-disable-next-line no-console
            console.info(
              `[PARAM_CACHE] SPS num_ref_frames=${info.numRefFrames} ` +
              `(profile=${info.profileIdc} level=${info.levelIdc}) — ` +
              `spec-valid for this level, but large DPB increases artifact ` +
              `persistence from any partial P-frame.`
            );
          }
        }
      }
    } catch (_) { /* non-fatal — validation best-effort only */ }

    return 'sps';
  }
  if (t === 8) {
    state.pps = Buffer.from(nal);
    state.receivedPps = true;
    return 'pps';
  }
  return null;
}

function hasSpsAndPps(state) {
  const s = ensureParamSetState(state);
  if (!s) return false;
  return !!(s.receivedSps && s.receivedPps &&
    s.sps && s.sps.length > 0 &&
    s.pps && s.pps.length > 0);
}

function canEmitIdr(state) {
  const s = ensureParamSetState(state);
  if (!s) return false;
  return hasSpsAndPps(s) && s.codecParamsConfirmed;
}

function getParamSetNals(state) {
  if (!hasSpsAndPps(state)) return [];
  return [state.sps, state.pps];
}

/**
 * Mark the cache as confirmed when both SPS and PPS are present.
 * Returns true the moment the cache transitions to "confirmed".
 */
function onParamSetUpdated(state) {
  if (!hasSpsAndPps(state)) return false;
  state.codecParamsConfirmed = true;
  return true;
}

module.exports = {
  initParamSetState,
  ensureParamSetState,
  storeParamSetNal,
  hasSpsAndPps,
  canEmitIdr,
  getParamSetNals,
  onParamSetUpdated
};
