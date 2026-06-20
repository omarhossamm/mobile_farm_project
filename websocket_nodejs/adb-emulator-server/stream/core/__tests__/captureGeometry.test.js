'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const geo = require('../captureGeometry');
const vectors = require('../geometry-test-vectors.json');

const TOL = 1e-6;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) <= TOL, `${msg}: ${a} != ${b}`);

test('buildCaptureGeometry emits v2 + flat legacy keys', () => {
  const g = geo.buildCaptureGeometry({
    provider: 'ios-coresim-iosurface',
    platform: 'ios',
    targetClass: 'simulator',
    deviceLogical: { w: 393, h: 852 },
    backingScale: 3,
    streamSize: { w: 393, h: 852 },
    rotation: 0
  });
  assert.equal(g.schema_version, 2);
  assert.equal(g.provider, 'ios-coresim-iosurface');
  assert.equal(g.device_logical.w, 393);
  assert.equal(g.capture_surface.w, 393 * 3);
  assert.equal(g.cropped, false);
  // Flat legacy keys for the desktop StreamMeta parser.
  assert.equal(g.device_logical_width, 393);
  assert.equal(g.stream_height, 852);
  assert.equal(g.coordinate_space, 'device_logical');
});

test('buildCaptureGeometry marks cropped when surface != full device pixels', () => {
  const g = geo.buildCaptureGeometry({
    provider: 'x', deviceLogical: { w: 100, h: 200 }, backingScale: 2,
    captureSurface: { w: 150, h: 200 }, streamSize: { w: 150, h: 200 }
  });
  assert.equal(g.cropped, true);
});

test('rotation round-trip is identity for all rotations', () => {
  for (const r of geo.VALID_ROTATIONS) {
    for (const [x, y] of [[0, 0], [1, 1], [0.25, 0.75], [0.1, 0.9], [0.5, 0.5]]) {
      const d = geo.deviceNormalizedToDisplay(x, y, r);
      const back = geo.displayToDeviceNormalized(d.nx, d.ny, r);
      close(back.nx, x, `rot ${r} nx`);
      close(back.ny, y, `rot ${r} ny`);
    }
  }
});

test('rotation vectors match shared test vectors (device → display)', () => {
  for (const v of vectors.rotationRoundTrip) {
    const d = geo.deviceNormalizedToDisplay(v.deviceN.nx, v.deviceN.ny, v.rotation);
    close(d.nx, v.displayN.nx, `F_${v.rotation} nx`);
    close(d.ny, v.displayN.ny, `F_${v.rotation} ny`);
    // And the inverse recovers the device-normalized input.
    const back = geo.displayToDeviceNormalized(v.displayN.nx, v.displayN.ny, v.rotation);
    close(back.nx, v.deviceN.nx, `G_${v.rotation} nx`);
    close(back.ny, v.deviceN.ny, `G_${v.rotation} ny`);
  }
});

test('contentRect matches shared vectors', () => {
  for (const v of vectors.contentRect) {
    const r = geo.contentRect(v.view.w, v.view.h, v.stream.w, v.stream.h);
    assert.ok(r, 'rect computed');
    close(r.x, v.rect.x, 'rect.x');
    close(r.y, v.rect.y, 'rect.y');
    close(r.w, v.rect.w, 'rect.w');
    close(r.h, v.rect.h, 'rect.h');
  }
});

test('normalizedToDevicePoints matches shared vectors', () => {
  for (const v of vectors.devicePoints) {
    const p = geo.normalizedToDevicePoints(v.deviceN.nx, v.deviceN.ny, v.deviceLogical);
    close(p.x, v.points.x, 'points.x');
    close(p.y, v.points.y, 'points.y');
  }
});

test('viewToDisplayNormalized returns null outside content rect', () => {
  // Portrait stream in a wide view → letterbox bars on left/right.
  const outside = geo.viewToDisplayNormalized(1, 400, 800, 800, 393, 852);
  assert.equal(outside, null);
  const inside = geo.viewToDisplayNormalized(400, 400, 800, 800, 393, 852);
  assert.ok(inside);
  close(inside.nx, 0.5, 'center nx');
  close(inside.ny, 0.5, 'center ny');
});

test('full touch transform: view → device points (portrait, no rotation)', () => {
  const g = geo.buildCaptureGeometry({
    provider: 'ios-coresim-iosurface', deviceLogical: { w: 393, h: 852 },
    backingScale: 3, streamSize: { w: 393, h: 852 }, rotation: 0
  });
  // Center of a square view over a portrait stream maps to device center.
  const dn = geo.viewToDisplayNormalized(400, 400, 800, 800, g.stream_size.w, g.stream_size.h);
  const dev = geo.displayToDeviceNormalized(dn.nx, dn.ny, g.rotation);
  const pts = geo.normalizedToDevicePoints(dev.nx, dev.ny, g.device_logical);
  close(pts.x, 196.5, 'device x');
  close(pts.y, 426, 'device y');
});
