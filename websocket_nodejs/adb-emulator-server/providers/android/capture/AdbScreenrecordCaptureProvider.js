/**
 * Android H.264 capture via adb screenrecord.
 * Thin adapter over the existing ScreenrecordCapture.
 * @module providers/android/capture/AdbScreenrecordCaptureProvider
 */

const { PLATFORMS } = require('../../../platform/types');
const { ScreenrecordCapture } = require('../../../stream/capture/ScreenrecordCapture');

class AdbScreenrecordCaptureProvider {
  constructor() {
    this.providerId = 'adb-screenrecord';
    this.platform = PLATFORMS.ANDROID;
    this.supportedTargets = ['emulator', 'physical', 'avd'];
  }

  supports(handle) {
    return handle.ref.platform === PLATFORMS.ANDROID;
  }

  async probe(ref) {
    if (ref.status !== 'online') {
      return { canCapture: false, reason: 'device offline or unauthorized' };
    }
    return { canCapture: true, format: 'h264-annexb', transport: 'adb-screenrecord' };
  }

  async startCapture(handle, options = {}) {
    return new ScreenrecordCapture(handle.ref.id, options);
  }
}

module.exports = { AdbScreenrecordCaptureProvider };
