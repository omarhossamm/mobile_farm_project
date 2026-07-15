/**
 * Strict startup state machine for WebRTC H.264 video.
 *
 *   WAIT_SDP_LOCAL  → offer created
 *   WAIT_SDP_REMOTE → answer received
 *   WAIT_DTLS       → sender DTLS connected
 *   WAIT_CODEC      → SPS + PPS parsed from screenrecord
 *   SEND_SPS_PPS    → STAP-A bootstrap written to wire
 *   WAIT_DECODER    → 300–800ms warm-up so FFmpeg consumes the parameter sets
 *   STREAMING       → gate open, VCL RTP allowed
 *
 * No VCL RTP packet may leave the server until STREAMING is reached.
 */

const { createLogger } = require('../lib/logger');

const logger = createLogger('MEDIA_GATE');

const STATE = Object.freeze({
  WAIT_SDP_LOCAL: 'wait_sdp_local',
  WAIT_SDP_REMOTE: 'wait_sdp_remote',
  WAIT_DTLS: 'wait_dtls',
  WAIT_CODEC: 'wait_codec',
  SEND_SPS_PPS: 'send_sps_pps',
  WAIT_DECODER: 'wait_decoder',
  STREAMING: 'streaming'
});

function createMediaStartupGate(sessionId) {
  return {
    sessionId,
    sdpLocalReady: false,
    sdpRemoteReady: false,
    dtlsReady: false,
    codecParamsReady: false,
    paramSetsFlushed: false,
    decoderReady: false,
    open: false,
    lastState: STATE.WAIT_SDP_LOCAL
  };
}

function currentState(gate) {
  if (!gate.sdpLocalReady) return STATE.WAIT_SDP_LOCAL;
  if (!gate.sdpRemoteReady) return STATE.WAIT_SDP_REMOTE;
  if (!gate.dtlsReady) return STATE.WAIT_DTLS;
  if (!gate.codecParamsReady) return STATE.WAIT_CODEC;
  if (!gate.paramSetsFlushed) return STATE.SEND_SPS_PPS;
  if (!gate.decoderReady) return STATE.WAIT_DECODER;
  return STATE.STREAMING;
}

function snapshot(gate) {
  return {
    state: currentState(gate),
    sdpLocalReady: gate.sdpLocalReady,
    sdpRemoteReady: gate.sdpRemoteReady,
    dtlsReady: gate.dtlsReady,
    codecParamsReady: gate.codecParamsReady,
    paramSetsFlushed: gate.paramSetsFlushed,
    decoderReady: gate.decoderReady,
    open: gate.open
  };
}

function noteTransition(gate, reason) {
  const next = currentState(gate);
  if (next === gate.lastState) return;
  logger.info('Startup state transition', {
    sessionId: gate.sessionId,
    from: gate.lastState,
    to: next,
    reason
  });
  gate.lastState = next;
}

/**
 * Flip a single boolean flag on the gate and emit a transition log if it
 * caused a state change. Use this from any place that toggles a gate flag so
 * the state-machine log shows every step accurately.
 *
 * @param {object} gate
 * @param {keyof gate} flag
 * @param {boolean} value
 * @param {string} reason
 */
function markFlag(gate, flag, value, reason) {
  if (gate[flag] === value) return;
  gate[flag] = value;
  noteTransition(gate, reason);
}

function canOpen(gate) {
  return gate.sdpLocalReady &&
    gate.sdpRemoteReady &&
    gate.dtlsReady &&
    gate.codecParamsReady &&
    gate.paramSetsFlushed &&
    gate.decoderReady;
}

/**
 * @returns {boolean} newly opened
 */
function tryOpen(gate, reason) {
  noteTransition(gate, reason);
  if (gate.open) return false;
  if (!canOpen(gate)) return false;
  gate.open = true;
  noteTransition(gate, reason);
  logger.info('Media startup gate OPEN — VCL RTP video allowed', {
    sessionId: gate.sessionId,
    reason,
    ...snapshot(gate)
  });
  return true;
}

module.exports = {
  STATE,
  createMediaStartupGate,
  currentState,
  snapshot,
  canOpen,
  tryOpen,
  markFlag
};
