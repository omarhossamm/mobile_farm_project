/**
 * Annex-B H.264 elementary stream parser (emulation-prevention aware).
 */

/**
 * Find Annex-B start code offsets (skip 0x000003 emulation prevention bytes).
 * @param {Buffer} buffer
 * @returns {{ index: number, len: 3 | 4 }[]}
 */
function findStartCodes(buffer) {
  const starts = [];
  if (!buffer || buffer.length < 4) return starts;

  let i = 0;
  while (i < buffer.length - 3) {
    if (buffer[i] === 0 && buffer[i + 1] === 0) {
      if (buffer[i + 2] === 1) {
        starts.push({ index: i, len: 3 });
        i += 3;
        continue;
      }
      if (buffer[i + 2] === 0 && i + 3 < buffer.length && buffer[i + 3] === 1) {
        starts.push({ index: i, len: 4 });
        i += 4;
        continue;
      }
      if (buffer[i + 2] === 3 && i + 3 < buffer.length) {
        // Emulation prevention byte — not a start code.
        i += 4;
        continue;
      }
    }
    i++;
  }
  return starts;
}

/**
 * Split buffer into complete NAL units (without start codes).
 * Requires a following start code so the last NAL in the buffer is never cut mid-payload.
 * @param {Buffer} buffer
 * @returns {{ nals: Buffer[], remainder: Buffer }}
 */
function extractNals(buffer) {
  const nals = [];
  if (!buffer || buffer.length < 4) {
    return { nals, remainder: buffer || Buffer.alloc(0) };
  }

  const starts = findStartCodes(buffer);
  if (starts.length < 2) {
    return { nals, remainder: buffer };
  }

  for (let s = 0; s < starts.length - 1; s++) {
    const start = starts[s].index + starts[s].len;
    const end = starts[s + 1].index;
    if (end > start) {
      nals.push(buffer.slice(start, end));
    }
  }

  const last = starts[starts.length - 1];
  const remainder = buffer.slice(last.index);
  return { nals, remainder };
}

/**
 * @param {Buffer} nal
 * @returns {number} NAL type (lower 5 bits of first byte after header)
 */
function nalType(nal) {
  if (!nal || nal.length === 0) return -1;
  return nal[0] & 0x1f;
}

module.exports = {
  extractNals,
  findStartCodes,
  nalType
};
