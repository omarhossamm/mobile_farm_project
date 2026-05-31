/**
 * H.264 RTP packetizer (RFC 6184) — single NAL and FU-A fragmentation.
 */

const MAX_PAYLOAD = 1200;

class H264RtpPacketizer {
  constructor(options = {}) {
    this.ssrc = options.ssrc ?? (Math.floor(Math.random() * 0xffffffff) >>> 0);
    this.payloadType = options.payloadType ?? 97;
    this.sequenceNumber = options.sequenceNumber ?? (Math.floor(Math.random() * 0xffff) & 0xffff);
    this.clockRate = 90000;
  }

  configure({ payloadType, ssrc } = {}) {
    if (payloadType != null) this.payloadType = payloadType;
    if (ssrc != null) this.ssrc = ssrc >>> 0;
  }

  /**
   * @param {Buffer} nal - NAL unit without start code
   * @param {number} timestamp - 90 kHz RTP timestamp
   * @param {boolean} isLastNalOfFrame - marker bit on final packet of access unit
   */
  packetize(nal, timestamp, isLastNalOfFrame = true) {
    if (!nal || nal.length === 0) return [];

    if (nal.length <= MAX_PAYLOAD) {
      return [this._buildPacket(nal, timestamp, isLastNalOfFrame)];
    }

    return this._packetizeFuA(nal, timestamp, isLastNalOfFrame);
  }

  /**
   * STAP-A aggregate for SPS/PPS (small parameter sets before a large IDR FU-A).
   */
  packetizeStapA(nals, timestamp, marker = true) {
    if (!nals || nals.length === 0) return [];

    const nri = nals[0][0] & 0x60;
    let total = 1;
    for (const nal of nals) total += 2 + nal.length;
    if (total > MAX_PAYLOAD) return [];

    const stap = Buffer.alloc(total);
    stap[0] = (nri & 0xe0) | 24;
    let off = 1;
    for (const nal of nals) {
      stap.writeUInt16BE(nal.length, off);
      off += 2;
      nal.copy(stap, off);
      off += nal.length;
    }
    return [this._buildPacket(stap, timestamp, marker)];
  }

  /** @private */
  _packetizeFuA(nal, timestamp, marker) {
    const packets = [];
    const nalType = nal[0] & 0x1f;
    const nri = nal[0] & 0x60;
    const fuIndicator = nri | 28; // FU-A type 28
    const fuHeaderStart = 0x80 | nalType;
    const fuHeaderMiddle = 0x00 | nalType;
    const fuHeaderEnd = 0x40 | nalType;

    let offset = 1;
    let first = true;

    while (offset < nal.length) {
      const maxChunk = MAX_PAYLOAD - 2;
      const remaining = nal.length - offset;
      const chunkLen = Math.min(maxChunk, remaining);
      const isLast = offset + chunkLen >= nal.length;

      const fuHeader = first ? fuHeaderStart : (isLast ? fuHeaderEnd : fuHeaderMiddle);
      const payload = Buffer.alloc(2 + chunkLen);
      payload[0] = fuIndicator;
      payload[1] = fuHeader;
      nal.copy(payload, 2, offset, offset + chunkLen);

      packets.push(this._buildPacket(payload, timestamp, isLast && marker));
      offset += chunkLen;
      first = false;
    }

    return packets;
  }

  /** @private */
  _buildPacket(payload, timestamp, marker) {
    const rtp = Buffer.alloc(12 + payload.length);
    rtp[0] = 0x80;
    rtp[1] = (marker ? 0x80 : 0x00) | (this.payloadType & 0x7f);
    rtp.writeUInt16BE(this.sequenceNumber & 0xffff, 2);
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
    rtp.writeUInt32BE(timestamp >>> 0, 4);
    rtp.writeUInt32BE(this.ssrc >>> 0, 8);
    payload.copy(rtp, 12);
    return rtp;
  }
}

module.exports = { H264RtpPacketizer };
