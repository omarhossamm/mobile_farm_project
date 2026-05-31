/**
 * H.264 codec helpers consumed by StreamManager.
 *
 * Only the public surface the streaming pipeline needs is re-exported here;
 * deeper helpers (NAL parsers, slice header parsing, etc.) live in their own
 * modules and are imported directly when needed.
 */

const { H264RtpPacketizer } = require('./h264RtpPacketizer');
const {
  processH264Chunk,
  tickAnnexBDrain,
  createStreamProcessorState,
  enableRtpEmit
} = require('./streamProcessor');
const {
  hasSpsAndPps,
  getParamSetNals,
  canEmitIdr
} = require('./paramSetCache');

module.exports = {
  H264RtpPacketizer,
  processH264Chunk,
  tickAnnexBDrain,
  createStreamProcessorState,
  enableRtpEmit,
  hasSpsAndPps,
  getParamSetNals,
  canEmitIdr
};
