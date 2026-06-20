'use strict';

/**
 * iOS primary capture provider: CoreSimulator IOSurface → VideoToolbox Baseline.
 *
 * Probe order:
 *   1. device is an iOS simulator and booted
 *   2. native coresim-capture helper is built
 *   3. helper --probe confirms the IOSurface is reachable
 *
 * @module providers/ios/capture/CoreSimIOSurfaceProvider
 */

const { PLATFORMS } = require('../../../platform/types');
const { CoreSimIOSurfaceStream, probeCoreSim } = require('../../../stream/capture/ios/CoreSimIOSurfaceStream');
const { createLogger } = require('../../../lib/logger');

const logger = createLogger('CORESIM_PROV');

class CoreSimIOSurfaceProvider {
  constructor() {
    this.providerId = 'ios-coresim-iosurface';
    this.platform = PLATFORMS.IOS;
    this.supportedTargets = ['simulator'];
  }

  supports(handle) {
    return handle.ref.platform === PLATFORMS.IOS && handle.ref.targetClass === 'simulator';
  }

  async probe(ref) {
    if (ref.status !== 'online') {
      return { canCapture: false, reason: 'simulator not booted' };
    }
    let result;
    try {
      result = await probeCoreSim(ref.id);
    } catch (err) {
      return { canCapture: false, reason: `coresim probe threw: ${err.message}` };
    }
    if (!result.ok) {
      logger.warn('coresim probe failed — will fall back to transcode', {
        udid: ref.id, reason: result.reason
      });
      return { canCapture: false, reason: result.reason };
    }
    logger.info('coresim probe passed', { udid: ref.id, surface: result.surface });
    return {
      canCapture: true,
      format: 'h264-annexb',
      transport: 'coresimulator-iosurface-videotoolbox'
    };
  }

  async startCapture(handle, options = {}) {
    const udid = handle.ref.id;
    const deviceTypeIdentifier = handle.ref.metadata?.deviceTypeIdentifier
      || handle.ref.deviceTypeIdentifier
      || '';
    logger.info('Starting coresim capture', { udid, deviceTypeIdentifier });
    return new CoreSimIOSurfaceStream(udid, {
      deviceTypeIdentifier,
      fps: options.fps,
      bitRate: options.bitRate
    });
  }
}

module.exports = { CoreSimIOSurfaceProvider };
