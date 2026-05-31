/**
 * Per-session SPS/PPS cache — strict SPS → PPS → IDR ordering for in-band RTP.
 *
 * State fields managed here (attached to the StreamProcessor state object):
 *   - sps, pps                Buffer | null    cached parameter set NALs
 *   - receivedSps, receivedPps                 first-seen flags
 *   - codecParamsConfirmed    bool              set once both NALs are cached
 */

const { nalType } = require('./h264AnnexBParser');

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
