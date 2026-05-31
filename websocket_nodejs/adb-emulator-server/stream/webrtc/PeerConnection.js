/**
 * Peer Connection Manager Module
 * Manages REAL WebRTC peer connections using werift (pure JS WebRTC)
 * Handles actual video streaming for Android emulator screen capture
 */

const { RTCPeerConnection, RTCSessionDescription, RtpPacket, useH264 } = require('werift');
const { streamConfig } = require('../../lib/config');
const { createLogger } = require('../../lib/logger');

const logger = createLogger('PEER');

/**
 * ICE server configuration
 */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

/** H.264 only — v2 capture/RTP path does not encode VP8. */
const H264_CODEC = useH264({
  payloadType: 97,
  parameters: 'packetization-mode=1;profile-level-id=42e01f'
});

function buildPeerConfig(options = {}) {
  const { codecs: _ignoredCodecs, iceServers, ...rest } = options;
  return {
    ...rest,
    iceServers: iceServers ?? ICE_SERVERS,
    // Always last — client payload.options must not restore Werift VP8 defaults.
    codecs: { video: [H264_CODEC] }
  };
}

/**
 * Remove VP8 from SDP and keep H.264 as the only video codec (Werift fallback safety net).
 * @param {string} sdp
 * @returns {string}
 */
function ensureH264OnlySdp(sdp) {
  if (!sdp) return sdp;
  if (!/H264\/90000/i.test(sdp) && !/h264\/90000/i.test(sdp)) {
    throw new Error('SDP has no H.264 rtpmap — cannot fix VideoIncompatible');
  }
  if (!/VP8\/90000/i.test(sdp)) return sdp;

  const vp8Pts = new Set();
  for (const line of sdp.split(/\r?\n/)) {
    const m = line.match(/^a=rtpmap:(\d+)\s+VP8\/90000/i);
    if (m) vp8Pts.add(m[1]);
  }
  if (vp8Pts.size === 0) return sdp;

  const lines = sdp.split(/\r?\n/).filter((line) => {
    if (/^a=rtpmap:\d+\s+VP8\/90000/i.test(line)) return false;
    for (const pt of vp8Pts) {
      if (new RegExp(`^a=fmtp:${pt}\\s`).test(line)) return false;
      if (new RegExp(`^a=rtcp-fb:${pt}\\s`).test(line)) return false;
    }
    return true;
  });

  const out = lines.map((line) => {
    if (!line.startsWith('m=video ')) return line;
    const parts = line.trim().split(/\s+/);
    const kept = parts.filter((p, i) => i < 3 || !vp8Pts.has(p));
    return kept.join(' ');
  });

  logger.warn('Stripped VP8 from SDP — H.264 only', { removedPayloadTypes: [...vp8Pts] });
  return out.join('\r\n') + (sdp.endsWith('\r\n') ? '\r\n' : '');
}

function getPreferredVideoCodec() {
  return H264_CODEC;
}

/**
 * Werift uses transceiver.codecs for SDP generation; sender.codec alone defaults to VP8.
 */
function applyH264ToTransceiver(transceiver) {
  if (!transceiver) return;
  const codec = getPreferredVideoCodec();
  transceiver.codecs = [codec];
  if (transceiver.sender) {
    transceiver.sender.codec = codec;
  }
}

function getCodecName() {
  return 'H264';
}

/**
 * Parse negotiated video codec from the client's SDP answer.
 * @param {string} sdp
 * @returns {'vp8' | 'h264'}
 */
function parseAnswerVideoCodec(sdp) {
  if (!sdp) return 'h264';

  const mLine = sdp.split('\n').find((l) => l.startsWith('m=video'));
  if (!mLine) return 'vp8';

  const payloads = mLine.trim().split(' ').slice(3);
  for (const pt of payloads) {
    const rtpmap = sdp.match(new RegExp(`a=rtpmap:${pt} ([^/]+)`, 'i'));
    if (!rtpmap) continue;
    const mime = rtpmap[1].toUpperCase();
    if (mime === 'VP8') return 'vp8';
    if (mime === 'H264') return 'h264';
  }

  if (/H264\/90000/i.test(sdp)) return 'h264';
  if (/VP8\/90000/i.test(sdp)) return 'vp8';
  return 'h264';
}

/**
 * PeerConnectionManager class
 * Manages REAL WebRTC peer connections with video tracks
 */
class PeerConnectionManager {
  constructor() {
    this.peers = new Map();
    this._onPipelineStart = null;
    this._onMediaReady = null;
  }

  /**
   * Register callback to start media pipeline (avoids circular require).
   */
  setPipelineStartHandler(handler) {
    this._onPipelineStart = handler;
  }

  /**
   * Fired when DTLS is connected — sync RTP params on encoders.
   */
  setMediaReadyHandler(handler) {
    this._onMediaReady = handler;
  }

  /**
   * @param {string} sessionId
   * @returns {{ codec: 'vp8' | 'h264', payloadType: number, ssrc?: number } | null}
   */
  getNegotiatedVideoInfo(sessionId) {
    const peerInfo = this.peers.get(sessionId);
    if (!peerInfo) return null;
    const sdp = peerInfo.pc?.remoteDescription?.sdp;
    const sendParams = this.getVideoSendParams(sessionId);
    return {
      codec: parseAnswerVideoCodec(sdp),
      payloadType: sendParams?.payloadType ?? 96,
      ssrc: sendParams?.ssrc
    };
  }

  _notifyMediaReady(sessionId) {
    const sendParams = this.getVideoSendParams(sessionId);
    const peerInfo = this.peers.get(sessionId);
    if (peerInfo) {
      this._syncNegotiatedCodec(peerInfo, sendParams);
    }
    logger.info('Media path ready for RTP', {
      sessionId,
      codec: parseAnswerVideoCodec(peerInfo?.pc?.remoteDescription?.sdp),
      payloadType: sendParams?.payloadType,
      ssrc: sendParams?.ssrc
    });
    if (this._onMediaReady) {
      this._onMediaReady(sessionId);
    }
  }

  _startPendingPipeline(sessionId) {
    if (!this._onPipelineStart) {
      logger.error('No pipeline start handler registered', { sessionId });
      return;
    }
    const startResult = this._onPipelineStart(sessionId);
    logger.info('Media pipeline started after connection ready', {
      sessionId,
      success: startResult?.success,
      error: startResult?.error
    });
  }

  /**
   * When sender DTLS becomes ready, start queued pipeline and log media path state.
   */
  _attachSenderReady(sessionId, peerInfo) {
    if (peerInfo.senderReadyAttached) {
      return;
    }
    peerInfo.senderReadyAttached = true;

    const tryAttach = () => {
      const sender = peerInfo.videoSender;
      if (!sender) {
        return false;
      }

      if (sender.onReady) {
        sender.onReady.subscribe(() => {
          const sendParams = this._readVideoSendParams(peerInfo);
          this._syncNegotiatedCodec(peerInfo, sendParams);
          logger.info('Video sender DTLS ready — RTP can be sent', {
            sessionId,
            dtlsState: sender.dtlsTransport?.state,
            payloadType: sendParams.payloadType
          });
          this._notifyMediaReady(sessionId);
          if (peerInfo.pendingPipelineStart) {
            peerInfo.pendingPipelineStart = false;
            this._startPendingPipeline(sessionId);
          }
        });
      }

      if (sender.dtlsTransport?.onStateChange) {
        sender.dtlsTransport.onStateChange.subscribe((state) => {
          logger.info('Sender DTLS state', { sessionId, state });
          if (state === 'connected') {
            this._notifyMediaReady(sessionId);
            if (peerInfo.pendingPipelineStart) {
              peerInfo.pendingPipelineStart = false;
              this._startPendingPipeline(sessionId);
            }
          }
        });
      }

      return true;
    };

    if (!tryAttach()) {
      setTimeout(() => tryAttach(), 100);
    }
  }

  /**
   * Create a WebRTC peer connection with video transceiver
   */
  createPeer(sessionId, options = {}) {
    if (!sessionId) {
      return { success: false, error: 'sessionId is required' };
    }

    if (this.peers.has(sessionId)) {
      logger.warn('Replacing existing peer (ensures H.264 transceiver)', { sessionId });
      this.closePeer(sessionId);
    }

    try {
      const pc = new RTCPeerConnection(buildPeerConfig(options));

      const peerId = `peer-${sessionId}-${Date.now()}`;

      // Add video transceiver in sendonly mode (server sends video to client)
      const transceiver = pc.addTransceiver('video', {
        direction: 'sendonly'
      });

      applyH264ToTransceiver(transceiver);

      const peerInfo = {
        peerId,
        sessionId,
        pc,
        transceiver,
        videoSender: transceiver.sender,
        state: 'new',
        iceConnectionState: 'new',
        signalingState: 'stable',
        createdAt: new Date().toISOString(),
        session: null,
        pendingCandidates: [],
        pendingPipelineStart: false,
        rtpStats: {
          packetsSent: 0,
          bytesSent: 0,
          framesSent: 0
        }
      };

      // ICE candidate handler - send to client
      pc.onIceCandidate.subscribe((candidate) => {
        if (candidate && peerInfo.session) {
          logger.debug('ICE candidate generated', { sessionId });
          peerInfo.session.send({
            type: 'ice_candidate',
            data: { candidate: candidate.toJSON() }
          });
        }
      });

      // ICE connection state handler
      pc.iceConnectionStateChange.subscribe(() => {
        peerInfo.iceConnectionState = pc.iceConnectionState;
        logger.info('ICE connection state changed', { 
          sessionId, 
          state: pc.iceConnectionState 
        });

        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          peerInfo.state = 'connected';
          logger.info('WebRTC peer connected - ready for video', { sessionId, peerId, iceState: pc.iceConnectionState });
          
          if (peerInfo.session) {
            peerInfo.session.send({
              type: 'peer_connected',
              data: { session_id: sessionId, peer_id: peerId }
            });
          }
        } else if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
          peerInfo.state = 'disconnected';
          logger.info('WebRTC peer disconnected', { sessionId });
        }
      });

      // Connection + DTLS handlers — start encoder as soon as the path is usable
      pc.connectionStateChange.subscribe(() => {
        logger.info('Connection state changed', {
          sessionId,
          state: pc.connectionState
        });

        if (peerInfo.pendingPipelineStart && pc.connectionState === 'connected') {
          peerInfo.pendingPipelineStart = false;
          this._startPendingPipeline(sessionId);
        }
      });

      this._attachSenderReady(sessionId, peerInfo);

      this.peers.set(sessionId, peerInfo);
      
      logger.info('Peer created with video transceiver', { 
        sessionId, 
        peerId,
        direction: 'sendonly',
        codec: getCodecName()
      });

      return { success: true, peerId };
    } catch (error) {
      logger.error('Failed to create peer', { sessionId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Attach session reference to peer for message delivery
   */
  attachPeer(sessionId, session) {
    const peerInfo = this.peers.get(sessionId);
    if (!peerInfo) {
      return { success: false, error: 'Peer not found' };
    }
    peerInfo.session = session;
    logger.info('Session attached to peer', { sessionId });
    return { success: true };
  }

  /**
   * Create SDP offer (server-initiated)
   */
  async createOffer(sessionId) {
    const peerInfo = this.peers.get(sessionId);
    if (!peerInfo) {
      return { success: false, error: 'Peer not found' };
    }

    try {
      applyH264ToTransceiver(peerInfo.transceiver);
      const rawOffer = await peerInfo.pc.createOffer();
      const sdp = ensureH264OnlySdp(rawOffer.sdp);
      if (/a=rtpmap:\d+ VP8\/90000/i.test(sdp)) {
        throw new Error('SDP offer still contains VP8 after H.264 enforcement');
      }
      const offer = { type: rawOffer.type, sdp };
      await peerInfo.pc.setLocalDescription(offer);

      const sendParams = this._readVideoSendParams(peerInfo);
      peerInfo.videoPayloadType = sendParams.payloadType;
      peerInfo.videoSsrc = sendParams.ssrc;
      this._syncNegotiatedCodec(peerInfo, sendParams);

      const rtpmaps = (offer.sdp.match(/^a=rtpmap:\d+ [^\r\n]+/gm) || []).join(', ');
      logger.info('SDP offer created (H.264 only)', {
        sessionId,
        sdpLength: offer.sdp.length,
        payloadType: sendParams.payloadType,
        ssrc: sendParams.ssrc,
        rtpmaps
      });

      return {
        success: true,
        offer: { type: offer.type, sdp: offer.sdp },
        sendParams
      };
    } catch (error) {
      logger.error('Failed to create offer', { sessionId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle remote SDP offer and create answer
   */
  async handleOffer(sessionId, offer) {
    const peerInfo = this.peers.get(sessionId);
    if (!peerInfo) {
      return { success: false, error: 'Peer not found' };
    }

    try {
      await peerInfo.pc.setRemoteDescription(
        new RTCSessionDescription(offer.sdp, offer.type)
      );

      // Add pending ICE candidates
      for (const candidate of peerInfo.pendingCandidates) {
        await peerInfo.pc.addIceCandidate(candidate);
      }
      peerInfo.pendingCandidates = [];

      applyH264ToTransceiver(peerInfo.transceiver);
      const rawAnswer = await peerInfo.pc.createAnswer();
      const sdp = ensureH264OnlySdp(rawAnswer.sdp);
      const answer = { type: rawAnswer.type, sdp };
      await peerInfo.pc.setLocalDescription(answer);

      logger.info('SDP offer handled, answer created', { sessionId });

      return {
        success: true,
        answer: { type: answer.type, sdp: answer.sdp }
      };
    } catch (error) {
      logger.error('Failed to handle offer', { sessionId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle remote SDP answer
   */
  async handleAnswer(sessionId, answer) {
    const peerInfo = this.peers.get(sessionId);
    if (!peerInfo) {
      return { success: false, error: 'Peer not found' };
    }

    try {
      await peerInfo.pc.setRemoteDescription(
        new RTCSessionDescription(answer.sdp, answer.type)
      );

      // Add pending ICE candidates
      for (const candidate of peerInfo.pendingCandidates) {
        await peerInfo.pc.addIceCandidate(candidate);
      }
      peerInfo.pendingCandidates = [];

      const sendParams = this._readVideoSendParams(peerInfo);
      peerInfo.videoPayloadType = sendParams.payloadType;
      peerInfo.videoSsrc = sendParams.ssrc;
      this._syncNegotiatedCodec(peerInfo, sendParams);

      logger.info('SDP answer processed', {
        sessionId,
        payloadType: sendParams.payloadType,
        ssrc: sendParams.ssrc,
        iceState: peerInfo.pc.iceConnectionState,
        dtlsState: peerInfo.videoSender?.dtlsTransport?.state
      });

      this._attachSenderReady(sessionId, peerInfo);

      // Brief wait for DTLS (non-blocking for the rest of startup)
      const mediaReady = await this.waitForMediaReady(sessionId, 5000);

      return { success: true, mediaReady, sendParams };
    } catch (error) {
      logger.error('Failed to handle answer', { sessionId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Wait until ICE + DTLS are ready to send RTP (werift drops packets otherwise).
   */
  async waitForMediaReady(sessionId, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.isMediaReady(sessionId)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.isMediaReady(sessionId);
  }

  /**
   * True when ICE is up and sender DTLS + codec are ready.
   */
  isMediaReady(sessionId) {
    const peerInfo = this.peers.get(sessionId);
    if (!peerInfo) {
      return false;
    }

    const dtlsState = peerInfo.videoSender?.dtlsTransport?.state;
    const hasCodec = peerInfo.videoSender?.codec != null;

    return this.isConnected(sessionId) && dtlsState === 'connected' && hasCodec;
  }

  /**
   * Queue pipeline start until media path is ready.
   */
  requestPipelineStart(sessionId) {
    const peerInfo = this.peers.get(sessionId);
    if (!peerInfo) {
      return { success: false, error: 'Peer not found' };
    }

    if (this.isMediaReady(sessionId)) {
      this._startPendingPipeline(sessionId);
      return { success: true, immediate: true };
    }

    peerInfo.pendingPipelineStart = true;
    logger.info('Pipeline start queued until DTLS connected', { sessionId });
    return { success: true, queued: true };
  }

  /**
   * Add ICE candidate
   */
  async addIceCandidate(sessionId, candidate) {
    const peerInfo = this.peers.get(sessionId);
    if (!peerInfo) {
      return { success: false, error: 'Peer not found' };
    }

    try {
      const normalized = this._normalizeIceCandidate(candidate);
      if (peerInfo.pc.remoteDescription) {
        await peerInfo.pc.addIceCandidate(normalized);
        logger.debug('ICE candidate added', { sessionId });
      } else {
        peerInfo.pendingCandidates.push(normalized);
        logger.debug('ICE candidate queued', { sessionId });
      }
      return { success: true };
    } catch (error) {
      logger.error('Failed to add ICE candidate', { sessionId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Send RTP packet via video transceiver
   * This is the REAL video transmission!
   */
  sendRtp(sessionId, rtpPacket) {
    const peerInfo = this.peers.get(sessionId);
    if (!peerInfo) {
      return { success: false, error: 'Peer not found' };
    }

    if (!this.isConnected(sessionId)) {
      return { success: false, error: 'Peer not connected', dropped: true };
    }

    try {
      const rtp = Buffer.isBuffer(rtpPacket) ? RtpPacket.deSerialize(rtpPacket) : rtpPacket;
      peerInfo.videoSender.sendRtp(rtp);

      peerInfo.rtpStats.packetsSent++;
      peerInfo.rtpStats.bytesSent += rtpPacket.length;

      return { success: true };
    } catch (error) {
      logger.error('Failed to send RTP', { sessionId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Send multiple RTP packets (for one video frame)
   */
  sendFrame(sessionId, rtpPackets) {
    const peerInfo = this.peers.get(sessionId);
    if (!peerInfo) {
      return { success: false, error: 'Peer not found' };
    }

    if (!this.isMediaReady(sessionId)) {
      return { success: false, error: 'Media not ready (DTLS/ICE)', dropped: true };
    }

    try {
      for (const packet of rtpPackets) {
        const rtp = Buffer.isBuffer(packet) ? RtpPacket.deSerialize(packet) : packet;
        peerInfo.videoSender.sendRtp(rtp);
        peerInfo.rtpStats.packetsSent++;
        peerInfo.rtpStats.bytesSent += Buffer.isBuffer(packet) ? packet.length : 0;
      }
      peerInfo.rtpStats.framesSent++;

      if (peerInfo.rtpStats.framesSent === 1) {
        logger.info('First video frame sent via WebRTC', {
          sessionId,
          packets: rtpPackets.length,
          payloadType: peerInfo.videoPayloadType,
          ssrc: peerInfo.videoSsrc
        });
      }

      return { success: true, packetsSent: rtpPackets.length };
    } catch (error) {
      logger.error('Failed to send frame', { sessionId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Negotiated VP8 RTP send parameters for a session.
   */
  getVideoSendParams(sessionId) {
    const peerInfo = this.peers.get(sessionId);
    if (!peerInfo) return null;
    if (peerInfo.videoPayloadType != null) {
      return {
        payloadType: peerInfo.videoPayloadType,
        ssrc: peerInfo.videoSsrc ?? peerInfo.videoSender?.ssrc
      };
    }
    return this._readVideoSendParams(peerInfo);
  }

  _readVideoSendParams(peerInfo) {
    const codec = peerInfo.videoSender?.codec;
    let payloadType = codec?.payloadType;
    const sdp = peerInfo.pc?.localDescription?.sdp || peerInfo.pc?.remoteDescription?.sdp;
    if (payloadType == null && sdp) {
      const preferH264 = getCodecName() === 'H264';
      const h264Match = sdp.match(/a=rtpmap:(\d+)\s+H264\/90000/i);
      const vp8Match = sdp.match(/a=rtpmap:(\d+)\s+VP8\/90000/i);
      if (preferH264 && h264Match) {
        payloadType = parseInt(h264Match[1], 10);
      } else if (vp8Match) {
        payloadType = parseInt(vp8Match[1], 10);
      } else if (h264Match) {
        payloadType = parseInt(h264Match[1], 10);
      }
    }
    return {
      payloadType: payloadType ?? 96,
      ssrc: peerInfo.videoSender?.ssrc
    };
  }

  /**
   * Werift sendRtp() overwrites PT from sender.codec — keep it aligned with SDP.
   */
  _normalizeIceCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') {
      return candidate;
    }
    let candStr = candidate.candidate;
    if (typeof candStr !== 'string' || !candStr.trim()) {
      return candidate;
    }
    candStr = candStr.trim();
    if (!candStr.startsWith('candidate:')) {
      candStr = `candidate:${candStr}`;
    }
    return { ...candidate, candidate: candStr };
  }

  _syncNegotiatedCodec(peerInfo, sendParams) {
    if (!peerInfo?.videoSender || sendParams?.payloadType == null) {
      return;
    }
    if (peerInfo.videoSender.codec) {
      peerInfo.videoSender.codec.payloadType = sendParams.payloadType;
    }
    if (sendParams.ssrc != null) {
      peerInfo.videoSender.ssrc = sendParams.ssrc;
    }
    logger.info('Synced sender codec to negotiated SDP', {
      sessionId: peerInfo.sessionId,
      payloadType: sendParams.payloadType,
      ssrc: sendParams.ssrc
    });
  }

  /**
   * Check if peer is connected and ready for video
   */
  isConnected(sessionId) {
    const peerInfo = this.peers.get(sessionId);
    if (!peerInfo) return false;
    const ice = peerInfo.pc.iceConnectionState;
    return peerInfo.state === 'connected' ||
      ice === 'connected' ||
      ice === 'completed';
  }

  /**
   * Get peer info
   */
  getPeer(sessionId) {
    const peerInfo = this.peers.get(sessionId);
    if (!peerInfo) return null;

    return {
      peerId: peerInfo.peerId,
      sessionId: peerInfo.sessionId,
      state: peerInfo.state,
      iceConnectionState: peerInfo.iceConnectionState,
      createdAt: peerInfo.createdAt,
      rtpStats: peerInfo.rtpStats
    };
  }

  /**
   * Get RTP statistics
   */
  getStats(sessionId) {
    const peerInfo = this.peers.get(sessionId);
    if (!peerInfo) return null;
    return { ...peerInfo.rtpStats };
  }

  /**
   * Close peer connection
   */
  closePeer(sessionId) {
    const peerInfo = this.peers.get(sessionId);
    if (!peerInfo) return { success: true };

    try {
      if (peerInfo.pc.connectionState !== 'closed') {
        peerInfo.pc.close();
      }
      this.peers.delete(sessionId);
      logger.info('Peer closed', { 
        sessionId, 
        framesSent: peerInfo.rtpStats.framesSent 
      });
      return { success: true, stats: peerInfo.rtpStats };
    } catch (error) {
      logger.error('Error closing peer', { sessionId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Cleanup all peers
   */
  cleanupAll() {
    for (const sessionId of this.peers.keys()) {
      this.closePeer(sessionId);
    }
  }
}

const peerConnectionManager = new PeerConnectionManager();
const peerConnection = peerConnectionManager;

module.exports = {
  peerConnection,
  peerConnectionManager,
  PeerConnectionManager,
  parseAnswerVideoCodec,
  getCodecName
};
