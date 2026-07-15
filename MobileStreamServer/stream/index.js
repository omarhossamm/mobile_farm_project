/**
 * Streaming exports — server Werift peer + adb screenrecord capture.
 */

const { streamManager } = require('./StreamManager');
const { peerConnectionManager } = require('./webrtc/PeerConnection');

module.exports = {
  streamManager,
  peerConnectionManager
};
