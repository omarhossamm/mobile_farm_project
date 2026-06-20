'use strict';

/**
 * iOS simulator logical-point dimensions + backing scale, keyed by simctl
 * deviceTypeIdentifier substrings.
 *
 * HID injection (idb) operates in POINTS, while CoreSimulator IOSurface capture
 * is in device PIXELS. We therefore must know the backing scale to convert the
 * captured pixel surface into the logical point space the touch system uses.
 *
 * When a device type is unknown, resolveDeviceGeometry() falls back to deriving
 * the scale from the captured surface size (modern iPhones ≥1080px wide → ×3,
 * everything else → ×2), which keeps geometry correct even for new hardware.
 *
 * @module config/iosDeviceSizes
 */

// deviceTypeIdentifier substring → { w, h (portrait points), scale }
const KNOWN = [
  // iPhone 16 family
  { match: 'iPhone-16-Pro-Max', w: 440, h: 956, scale: 3 },
  { match: 'iPhone-16-Pro', w: 402, h: 874, scale: 3 },
  { match: 'iPhone-16-Plus', w: 430, h: 932, scale: 3 },
  { match: 'iPhone-16', w: 393, h: 852, scale: 3 },
  // iPhone 15 family
  { match: 'iPhone-15-Pro-Max', w: 430, h: 932, scale: 3 },
  { match: 'iPhone-15-Pro', w: 393, h: 852, scale: 3 },
  { match: 'iPhone-15-Plus', w: 430, h: 932, scale: 3 },
  { match: 'iPhone-15', w: 393, h: 852, scale: 3 },
  // iPhone 14 family
  { match: 'iPhone-14-Pro-Max', w: 430, h: 932, scale: 3 },
  { match: 'iPhone-14-Pro', w: 393, h: 852, scale: 3 },
  { match: 'iPhone-14-Plus', w: 428, h: 926, scale: 3 },
  { match: 'iPhone-14', w: 390, h: 844, scale: 3 },
  // iPhone 13 / 12 family
  { match: 'iPhone-13-Pro-Max', w: 428, h: 926, scale: 3 },
  { match: 'iPhone-13-mini', w: 375, h: 812, scale: 3 },
  { match: 'iPhone-13', w: 390, h: 844, scale: 3 },
  { match: 'iPhone-12-Pro-Max', w: 428, h: 926, scale: 3 },
  { match: 'iPhone-12-mini', w: 375, h: 812, scale: 3 },
  { match: 'iPhone-12', w: 390, h: 844, scale: 3 },
  // iPhone 11 / XR / XS
  { match: 'iPhone-11-Pro-Max', w: 414, h: 896, scale: 3 },
  { match: 'iPhone-11-Pro', w: 375, h: 812, scale: 3 },
  { match: 'iPhone-11', w: 414, h: 896, scale: 2 },
  // SE
  { match: 'iPhone-SE-3rd', w: 375, h: 667, scale: 2 },
  { match: 'iPhone-SE', w: 375, h: 667, scale: 2 },
  // iPad (representative; @2x)
  { match: 'iPad-Pro-13', w: 1032, h: 1376, scale: 2 },
  { match: 'iPad-Pro-12-9', w: 1024, h: 1366, scale: 2 },
  { match: 'iPad-Pro-11', w: 834, h: 1194, scale: 2 },
  { match: 'iPad-Air', w: 820, h: 1180, scale: 2 },
  { match: 'iPad-mini', w: 744, h: 1133, scale: 2 },
  { match: 'iPad', w: 810, h: 1080, scale: 2 }
];

/**
 * Resolve logical-point geometry for a device.
 *
 * @param {string} deviceTypeIdentifier  e.g. 'com.apple.CoreSimulator.SimDeviceType.iPhone-15'
 * @param {{w:number,h:number}} [surfacePixels]  captured IOSurface pixel size
 * @returns {{ logical:{w:number,h:number}, scale:number, source:string }}
 */
function resolveDeviceGeometry(deviceTypeIdentifier, surfacePixels) {
  const id = deviceTypeIdentifier || '';
  const entry = KNOWN.find((k) => id.includes(k.match));

  const px = surfacePixels && surfacePixels.w > 0 && surfacePixels.h > 0
    ? { w: Math.round(surfacePixels.w), h: Math.round(surfacePixels.h) }
    : null;

  if (entry) {
    // Orient the catalog points to match the captured surface orientation.
    let logical = { w: entry.w, h: entry.h };
    if (px && px.w > px.h) {
      logical = { w: entry.h, h: entry.w }; // landscape capture
    }
    return { logical, scale: entry.scale, source: 'catalog' };
  }

  // Unknown device — derive from the captured surface.
  if (px) {
    const minDim = Math.min(px.w, px.h);
    const scale = minDim >= 1080 ? 3 : 2;
    return {
      logical: { w: Math.round(px.w / scale), h: Math.round(px.h / scale) },
      scale,
      source: 'derived'
    };
  }

  return { logical: { w: 0, h: 0 }, scale: 1, source: 'unknown' };
}

module.exports = { resolveDeviceGeometry, KNOWN };
