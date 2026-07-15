'use strict';

/**
 * CaptureGeometry — the single authoritative coordinate-space model.
 *
 * One immutable object is authored at capture time, transported verbatim to the
 * client (as `stream_meta`), and consumed by BOTH the client touch mapper and
 * the server control provider. Every space conversion is a pure, invertible
 * function of this object — no constants, no magic offsets, no duplicate
 * mappers.
 *
 * Coordinate spaces
 * ─────────────────
 *   deviceLogical   — points (e.g. iPhone 15 = 393×852). The HID injection basis.
 *   backingScale    — device pixels per point (×2 / ×3 on retina simulators).
 *   captureSurface  — IOSurface pixel size. For CoreSimulator capture this IS
 *                     the device screen at device pixels (no chrome, no crop).
 *   streamSize      — encoded frame pixel size (what the client decodes/displays).
 *   rotation        — 0/90/180/270, clockwise, of the displayed frame relative
 *                     to the device's native orientation.
 *
 * Touch transform (client → device)
 * ─────────────────────────────────
 *   UI pointer (control px)
 *     → contentRect letterbox  → displayNormalized ∈ [0,1]²  (basis = streamSize)
 *     → displayToDeviceNormalized(rotation)  → deviceNormalized ∈ [0,1]²
 *     → × deviceLogical  → device points  → HID inject
 *
 * Because CoreSimulator capture makes streamSize a pure scale of the device
 * screen, "normalized over stream" == "normalized over device" by construction.
 *
 * @module stream/core/captureGeometry
 */

const SCHEMA_VERSION = 2;
const VALID_ROTATIONS = Object.freeze([0, 90, 180, 270]);

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function normalizeRotation(rotation) {
  const r = ((Math.round(Number(rotation) || 0) % 360) + 360) % 360;
  return VALID_ROTATIONS.includes(r) ? r : 0;
}

function dim(obj, w = 0, h = 0) {
  return {
    w: Math.max(0, Math.round(Number(obj?.w ?? w) || 0)),
    h: Math.max(0, Math.round(Number(obj?.h ?? h) || 0))
  };
}

/**
 * Build a CaptureGeometry (stream_meta v2). Emits the nested v2 shape AND the
 * flat legacy keys the existing desktop StreamMeta parser understands, so the
 * client keeps working through the migration.
 *
 * @param {object} p
 * @param {string} p.provider        provider id (e.g. 'ios-coresim-iosurface')
 * @param {string} [p.platform]      'ios' | 'android'
 * @param {string} [p.targetClass]   'simulator' | 'emulator' | ...
 * @param {{w:number,h:number}} p.deviceLogical
 * @param {number} [p.backingScale]
 * @param {{w:number,h:number}} [p.captureSurface]
 * @param {{w:number,h:number}} p.streamSize
 * @param {number} [p.rotation]
 * @param {boolean} [p.cropped]
 * @returns {object} frozen geometry object
 */
function buildCaptureGeometry(p = {}) {
  const deviceLogical = dim(p.deviceLogical);
  const streamSize = dim(p.streamSize, deviceLogical.w, deviceLogical.h);
  const backingScale = Number(p.backingScale) > 0 ? Number(p.backingScale) : 1;
  const captureSurface = dim(
    p.captureSurface,
    Math.round(deviceLogical.w * backingScale),
    Math.round(deviceLogical.h * backingScale)
  );
  const rotation = normalizeRotation(p.rotation);

  // cropped is true only if the captured surface is not the full device screen.
  const fullSurface = captureSurface.w === Math.round(deviceLogical.w * backingScale)
    && captureSurface.h === Math.round(deviceLogical.h * backingScale);
  const cropped = p.cropped === true ? true : !fullSurface && deviceLogical.w > 0;

  const geometry = {
    // ── v2 nested ───────────────────────────────────────────────────────────
    schema_version: SCHEMA_VERSION,
    provider: p.provider || 'unknown',
    platform: p.platform || 'ios',
    target_class: p.targetClass || 'simulator',
    device_logical: { w: deviceLogical.w, h: deviceLogical.h },
    backing_scale: backingScale,
    capture_surface: { w: captureSurface.w, h: captureSurface.h },
    stream_size: { w: streamSize.w, h: streamSize.h },
    rotation,
    cropped,

    // ── flat legacy keys (consumed by desktop StreamMeta.FromJsonElement) ─────
    coordinate_space: 'device_logical',
    device_logical_width: deviceLogical.w,
    device_logical_height: deviceLogical.h,
    stream_width: streamSize.w,
    stream_height: streamSize.h
  };

  return Object.freeze(geometry);
}

/**
 * Letterbox content rect (Stretch=Uniform) of streamSize inscribed in viewSize.
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
function contentRect(viewW, viewH, streamW, streamH) {
  if (viewW <= 0 || viewH <= 0 || streamW <= 0 || streamH <= 0) return null;
  const videoAspect = streamW / streamH;
  const viewAspect = viewW / viewH;
  let w;
  let h;
  if (viewAspect > videoAspect) {
    h = viewH;
    w = h * videoAspect;
  } else {
    w = viewW;
    h = w / videoAspect;
  }
  return { x: (viewW - w) / 2, y: (viewH - h) / 2, w, h };
}

/**
 * UI pointer (in the video control) → display-normalized [0,1], letterbox-aware.
 * @returns {{nx:number,ny:number}|null} null if outside the content rect
 */
function viewToDisplayNormalized(px, py, viewW, viewH, streamW, streamH) {
  const rect = contentRect(viewW, viewH, streamW, streamH);
  if (!rect) return null;
  if (px < rect.x || py < rect.y || px > rect.x + rect.w || py > rect.y + rect.h) {
    return null;
  }
  return {
    nx: clamp01((px - rect.x) / rect.w),
    ny: clamp01((py - rect.y) / rect.h)
  };
}

/**
 * Inverse rotation G_r: display-normalized → device-normalized.
 * Self-consistent with deviceNormalizedToDisplay (G_r ∘ F_r = identity).
 */
function displayToDeviceNormalized(nx, ny, rotation) {
  const x = clamp01(nx);
  const y = clamp01(ny);
  switch (normalizeRotation(rotation)) {
    case 90: return { nx: y, ny: 1 - x };
    case 180: return { nx: 1 - x, ny: 1 - y };
    case 270: return { nx: 1 - y, ny: x };
    default: return { nx: x, ny: y };
  }
}

/**
 * Forward rotation F_r: device-normalized → display-normalized. (Used in tests.)
 */
function deviceNormalizedToDisplay(nx, ny, rotation) {
  const x = clamp01(nx);
  const y = clamp01(ny);
  switch (normalizeRotation(rotation)) {
    case 90: return { nx: 1 - y, ny: x };
    case 180: return { nx: 1 - x, ny: 1 - y };
    case 270: return { nx: y, ny: 1 - x };
    default: return { nx: x, ny: y };
  }
}

/**
 * device-normalized [0,1] → device points (logical), the HID injection basis.
 */
function normalizedToDevicePoints(nx, ny, deviceLogical) {
  const w = Number(deviceLogical?.w) || 0;
  const h = Number(deviceLogical?.h) || 0;
  return { x: clamp01(nx) * w, y: clamp01(ny) * h };
}

module.exports = {
  SCHEMA_VERSION,
  VALID_ROTATIONS,
  clamp01,
  normalizeRotation,
  buildCaptureGeometry,
  contentRect,
  viewToDisplayNormalized,
  displayToDeviceNormalized,
  deviceNormalizedToDisplay,
  normalizedToDevicePoints
};
