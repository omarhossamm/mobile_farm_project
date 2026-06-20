/**
 * Minimal H.264 SPS RBSP parser — extracts num_ref_frames and level_idc.
 *
 * Supports Baseline / Main / High Profile (profile_idc 66/77/88/100/110/122).
 * Used to validate that the capture process is not declaring an unreasonably
 * large DPB, which would cause FFmpeg to log:
 *   "number of reference frames (N+M) exceeds max (15; probably corrupt input)"
 *
 * Only the fields needed to reach num_ref_frames are parsed; the rest of
 * the SPS is left unread.
 */

'use strict';

// ─── bit-level helpers ────────────────────────────────────────────────────────

function readBitAt(data, bitIndex) {
  const byteIndex = bitIndex >> 3;
  if (byteIndex >= data.length) return 0;
  return (data[byteIndex] >> (7 - (bitIndex & 7))) & 1;
}

function readBits(data, bitPosRef, n) {
  let v = 0;
  for (let i = 0; i < n; i++) {
    v = (v << 1) | readBitAt(data, bitPosRef.value++);
  }
  return v;
}

/** Exp-Golomb unsigned ue(v). */
function readUe(data, bitPosRef) {
  let leadingZeros = 0;
  while (bitPosRef.value < data.length * 8) {
    if (readBitAt(data, bitPosRef.value++) !== 0) break;
    if (++leadingZeros > 31) throw new Error('ue overflow');
  }
  let suffix = 0;
  for (let i = 0; i < leadingZeros; i++) {
    suffix = (suffix << 1) | readBitAt(data, bitPosRef.value++);
  }
  return (1 << leadingZeros) - 1 + suffix;
}

/** Exp-Golomb signed se(v). */
function readSe(data, bitPosRef) {
  const codeNum = readUe(data, bitPosRef);
  return codeNum % 2 === 0 ? -(codeNum >> 1) : (codeNum + 1) >> 1;
}

/** Remove RBSP emulation-prevention bytes (0x00 0x00 0x03). */
function unescapeRbsp(data) {
  if (!data || data.length === 0) return Buffer.alloc(0);
  const out = [];
  for (let i = 0; i < data.length; i++) {
    if (i >= 2 && data[i] === 0x03 && data[i - 1] === 0 && data[i - 2] === 0) continue;
    out.push(data[i]);
  }
  return Buffer.from(out);
}

// ─── scaling list skip ────────────────────────────────────────────────────────

/**
 * Skip one scaling list (H.264 §7.3.2.1.1.1).
 * sizeOfScalingList: 16 for 4x4, 64 for 8x8.
 */
function skipScalingList(rbsp, bitPosRef, sizeOfScalingList) {
  let lastScale = 8;
  let nextScale = 8;
  for (let j = 0; j < sizeOfScalingList; j++) {
    if (nextScale !== 0) {
      const deltaScale = readSe(rbsp, bitPosRef);
      nextScale = (lastScale + deltaScale + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Parse the H.264 SPS NAL unit (without start code) and return:
 *   { profileIdc, levelIdc, numRefFrames }
 * Returns null on parse failure (SPS too short / unsupported profile).
 *
 * @param {Buffer} spsNal  - SPS NAL bytes (first byte = NAL header, type 7)
 * @returns {{ profileIdc: number, levelIdc: number, numRefFrames: number }|null}
 */
function parseSpsInfo(spsNal) {
  if (!spsNal || spsNal.length < 4) return null;
  try {
    // Byte 0: NAL header (type 7 = SPS)
    const rbsp = unescapeRbsp(spsNal.subarray(1));
    if (rbsp.length < 3) return null;

    const profileIdc = rbsp[0];      // u(8)
    // rbsp[1] = constraint flags + reserved_zero_2bits
    const levelIdc = rbsp[2];        // u(8)

    const bitPosRef = { value: 24 }; // skip profile_idc + flags + level_idc

    readUe(rbsp, bitPosRef); // seq_parameter_set_id

    // High-Profile family has extra fields before the common ones.
    const highProfileIds = new Set([44, 83, 86, 100, 110, 118, 122, 128, 138, 139, 134, 135]);
    if (highProfileIds.has(profileIdc)) {
      const chromaFormatIdc = readUe(rbsp, bitPosRef);
      if (chromaFormatIdc === 3) readBits(rbsp, bitPosRef, 1); // separate_colour_plane_flag
      readUe(rbsp, bitPosRef); // bit_depth_luma_minus8
      readUe(rbsp, bitPosRef); // bit_depth_chroma_minus8
      readBits(rbsp, bitPosRef, 1); // qpprime_y_zero_transform_bypass_flag

      const scalingMatrixPresent = readBits(rbsp, bitPosRef, 1);
      if (scalingMatrixPresent) {
        const numLists = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < numLists; i++) {
          const listPresent = readBits(rbsp, bitPosRef, 1);
          if (listPresent) skipScalingList(rbsp, bitPosRef, i < 6 ? 16 : 64);
        }
      }
    }

    readUe(rbsp, bitPosRef); // log2_max_frame_num_minus4
    const picOrderCntType = readUe(rbsp, bitPosRef);

    if (picOrderCntType === 0) {
      readUe(rbsp, bitPosRef); // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      readBits(rbsp, bitPosRef, 1); // delta_pic_order_always_zero_flag
      readSe(rbsp, bitPosRef);      // offset_for_non_ref_pic
      readSe(rbsp, bitPosRef);      // offset_for_top_to_bottom_field
      const n = readUe(rbsp, bitPosRef); // num_ref_frames_in_pic_order_cnt_cycle
      for (let i = 0; i < n; i++) readSe(rbsp, bitPosRef); // offset_for_ref_frame[i]
    }

    const numRefFrames = readUe(rbsp, bitPosRef);

    return { profileIdc, levelIdc, numRefFrames };
  } catch (_) {
    return null; // partial or malformed SPS — caller decides what to do
  }
}

/**
 * Compute the H.264 level-based MaxDpbFrames limit for a given resolution.
 * Used to validate that num_ref_frames is within spec.
 *
 * Ref: ITU-T H.264 Table A-1 (MaxDpbMbs per level).
 *
 * @param {number} levelIdc  e.g. 40 = Level 4.0, 41 = Level 4.1
 * @param {number} widthPx
 * @param {number} heightPx
 * @returns {number} max frames allowed in DPB, or 16 if unknown
 */
function maxDpbFramesForLevel(levelIdc, widthPx, heightPx) {
  const levelMaxDpbMbs = {
    10: 396, 11: 900, 12: 2376, 13: 2376,
    20: 2376, 21: 4752, 22: 8100,
    30: 8100, 31: 18000, 32: 20480,
    40: 32768, 41: 32768, 42: 34816,
    50: 110400, 51: 184320, 52: 184320,
    60: 696320, 61: 696320, 62: 696320
  };
  const maxDpbMbs = levelMaxDpbMbs[levelIdc] ?? 32768;
  const frameMbs = Math.ceil(widthPx / 16) * Math.ceil(heightPx / 16);
  if (frameMbs === 0) return 16;
  return Math.min(16, Math.max(1, Math.floor(maxDpbMbs / frameMbs)));
}

module.exports = { parseSpsInfo, maxDpbFramesForLevel };
