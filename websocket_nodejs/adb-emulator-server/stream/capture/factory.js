/**
 * Server-side capture: adb screenrecord → H.264 stdout.
 */

const { ScreenrecordCapture } = require('./ScreenrecordCapture');

function createCapture(deviceId, options = {}) {
  return new ScreenrecordCapture(deviceId, options);
}

module.exports = { createCapture };
