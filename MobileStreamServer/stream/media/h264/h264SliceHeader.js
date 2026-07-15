/**
 * H.264 slice header parsing (first_mb_in_slice) with RBSP emulation-prevention removal.
 */

function readBitAt(data, bitIndex) {
  const i = bitIndex >> 3;
  if (i >= data.length) return 0;
  const o = 7 - (bitIndex & 7);
  return (data[i] >> o) & 1;
}

/**
 * @param {Buffer} rbsp - escaped RBSP (no emulation prevention bytes)
 * @param {{ value: number }} bitPosRef
 */
function readUe(rbsp, bitPosRef) {
  let leadingZeroBits = 0;
  while (bitPosRef.value < rbsp.length * 8) {
    if (readBitAt(rbsp, bitPosRef.value++) !== 0) break;
    leadingZeroBits++;
    if (leadingZeroBits > 31) throw new Error('ue overflow');
  }

  let suffix = 0;
  for (let i = 0; i < leadingZeroBits; i++) {
    suffix = (suffix << 1) | readBitAt(rbsp, bitPosRef.value++);
  }
  return (1 << leadingZeroBits) - 1 + suffix;
}

/**
 * Remove emulation prevention bytes (0x000003) from RBSP.
 * @param {Buffer} data
 */
function unescapeRbsp(data) {
  if (!data || data.length === 0) return Buffer.alloc(0);
  const out = [];
  for (let i = 0; i < data.length; i++) {
    if (i >= 2 && data[i] === 0x03 && data[i - 1] === 0 && data[i - 2] === 0) {
      continue;
    }
    out.push(data[i]);
  }
  return Buffer.from(out);
}

/**
 * @param {Buffer} nal - NAL unit without start code
 * @returns {number|null}
 */
function parseFirstMbInSlice(nal) {
  if (!nal || nal.length < 2) return null;
  const nalType = nal[0] & 0x1f;
  if (nalType !== 1 && nalType !== 5) return null;

  const rbsp = unescapeRbsp(nal.subarray(1));
  if (rbsp.length === 0) return null;

  const bitPosRef = { value: 0 };
  try {
    return readUe(rbsp, bitPosRef);
  } catch (_) {
    return null;
  }
}

module.exports = { parseFirstMbInSlice };
