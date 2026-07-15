'use strict';

/**
 * iOS simulator lifecycle via `xcrun simctl boot/shutdown`.
 * @module providers/ios/lifecycle/SimulatorLifecycleProvider
 */

const simctl = require('../../../lib/simctl');
const { PLATFORMS } = require('../../../platform/types');
const { createLogger } = require('../../../lib/logger');

const logger = createLogger('IOS_LIFECYCLE');

class SimulatorLifecycleProvider {
  constructor() {
    this.providerId = 'ios-simctl-lifecycle';
    this.platform = PLATFORMS.IOS;
  }

  supports(ref) {
    return ref.platform === PLATFORMS.IOS;
  }

  async acquire(ref, sessionId, _options = {}) {
    const udid = ref.id;
    if (ref.status === 'online' || await simctl.isBooted(udid)) {
      return { success: true, deviceId: udid, alreadyRunning: true };
    }

    logger.info('Booting simulator', { udid, sessionId });
    const boot = await simctl.boot(udid);
    if (!boot.success) {
      return { success: false, error: `simctl boot failed: ${boot.error}` };
    }
    const booted = await simctl.waitUntilBooted(udid, 90_000);
    if (!booted) {
      return { success: false, error: `simulator ${udid} did not reach Booted state` };
    }
    return { success: true, deviceId: udid, booted: true, ownedBySession: !boot.alreadyRunning };
  }

  async release(handle, options = {}) {
    const { killOnDisconnect = false } = options;
    const udid = handle.ref.id;
    // Shutting simulators down on every disconnect is disruptive on a shared
    // farm. Only shut down when this session booted it AND killOnDisconnect.
    if (killOnDisconnect && handle.ownedBySession) {
      logger.info('Shutting down simulator', { udid });
      return simctl.shutdown(udid);
    }
    return { success: true };
  }
}

module.exports = { SimulatorLifecycleProvider };
