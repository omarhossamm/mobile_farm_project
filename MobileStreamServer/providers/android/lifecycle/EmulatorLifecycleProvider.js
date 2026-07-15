/**
 * Android emulator/device lifecycle — wraps emulatorManager.
 * @module providers/android/lifecycle/EmulatorLifecycleProvider
 */

const { emulatorManager } = require('../../../emulatorManager');
const { PLATFORMS } = require('../../../platform/types');

class EmulatorLifecycleProvider {
  constructor() {
    this.providerId = 'android-emulator-lifecycle';
    this.platform = PLATFORMS.ANDROID;
  }

  supports(ref) {
    return ref.platform === PLATFORMS.ANDROID;
  }

  async acquire(ref, sessionId, options = {}) {
    if (ref.targetClass === 'avd' || (ref.status === 'offline' && ref.metadata?.avd_name)) {
      const avdName = ref.metadata?.avd_name || ref.id;
      return emulatorManager.getOrStartEmulator(sessionId, avdName, options);
    }

    if (ref.status === 'online') {
      return { success: true, deviceId: ref.id, alreadyRunning: true };
    }

    return { success: false, error: `Device ${ref.id} is not available (${ref.status})` };
  }

  async release(handle, options = {}) {
    const { killOnDisconnect = true } = options;
    const deviceId = handle.ref.id;

    if (killOnDisconnect && handle.ownedBySession) {
      return emulatorManager.stopEmulator(deviceId, handle.leaseId);
    }

    emulatorManager.unbindEmulator(deviceId, handle.leaseId);
    return { success: true };
  }
}

module.exports = { EmulatorLifecycleProvider };
