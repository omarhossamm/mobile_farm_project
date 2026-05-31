/**
 * Streaming exports — server Werift peer + adb screenrecord capture.
 */

const { streamManager } = require('./StreamManager');
const { peerConnectionManager, getCodecName } = require('./webrtc/PeerConnection');
const { createCapture } = require('./capture/factory');

module.exports = {
  streamManager,
  peerConnectionManager,
  createCapture,
  getCodecName
};
