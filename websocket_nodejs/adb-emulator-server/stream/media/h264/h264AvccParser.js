/**
 * AVCC (length-prefixed) H.264 access unit parser — MediaCodec output format.
 */

/**
 * @param {Buffer} buffer
 * @returns {{ nals: Buffer[], remainder: Buffer }}
 */
function extractAvccNals(buffer) {
  const nals = [];
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const len = buffer.readUInt32BE(offset);
    offset += 4;
    if (len <= 0 || offset + len > buffer.length) {
      offset -= 4;
      break;
    }
    nals.push(buffer.slice(offset, offset + len));
    offset += len;
  }

  return { nals, remainder: buffer.slice(offset) };
}

module.exports = { extractAvccNals };
