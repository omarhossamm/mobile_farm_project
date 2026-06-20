/**
 * Android capture provider: scrcpy-server → native MediaCodec H.264.
 *
 * Replaces the adb-screenrecord provider as the primary Android capture path.
 * adb-screenrecord remains registered as a fallback for devices or environments
 * where scrcpy-server.jar is not available (CI, restricted environments, etc.).
 *
 * See stream/capture/android/ScrcpyCaptureStream.js for full protocol notes.
 *
 * @module providers/android/capture/ScrcpyCaptureProvider
 */

'use strict';

const path = require('path');
const { PLATFORMS } = require('../../../platform/types');
const {
  ScrcpyCaptureStream,
  probeScrcpy,
  SERVER_JAR_PATH,
  SCRCPY_VERSION
} = require('../../../stream/capture/android/ScrcpyCaptureStream');
const { createLogger } = require('../../../lib/logger');

const logger = createLogger('SCRCPY_PROV');

class ScrcpyCaptureProvider {
  constructor() {
    this.providerId       = 'scrcpy-capture';
    this.platform         = PLATFORMS.ANDROID;
    this.supportedTargets = ['emulator', 'physical', 'avd'];
  }

  supports(handle) {
    return handle.ref.platform === PLATFORMS.ANDROID;
  }

  /**
   * Verify prerequisites in order:
   *   1. scrcpy-server.jar present at the absolute resolved path.
   *   2. adb binary reachable (respects ADB_PATH env var).
   *   3. Device responds to `adb -s <serial> shell echo` with explicit targeting.
   */
  async probe(ref) {
    if (ref.status !== 'online') {
      return { canCapture: false, reason: 'device offline or unauthorized' };
    }

    let result;
    try {
      result = await probeScrcpy(ref.id);
    } catch (err) {
      // Unexpected throw from probeScrcpy (e.g. Node fs/exec internals).
      // eslint-disable-next-line no-console
      console.error(
        `\n[PROBE CRITICAL FAILURE] scrcpy-capture`,
        `\n  Device  : ${ref.id}`,
        `\n  Jar path: ${path.resolve(SERVER_JAR_PATH)}`,
        `\n  Error   : ${err.message}`,
        `\n  Stack   : ${err.stack}\n`
      );
      logger.error('scrcpy probe threw unexpectedly', {
        serial: ref.id,
        error:  err.message,
        stack:  err.stack
      });
      return { canCapture: false, reason: `scrcpy probe threw: ${err.message}` };
    }

    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error(
        `\n[PROBE CRITICAL FAILURE] scrcpy-capture — falling back to adb-screenrecord`,
        `\n  Device  : ${ref.id}`,
        `\n  Jar path: ${result.jarPath || path.resolve(SERVER_JAR_PATH)}`,
        `\n  ADB     : ${result.adbPath || 'adb'}`,
        `\n  Reason  : ${result.reason}\n`
      );
      logger.warn('scrcpy-capture probe failed', {
        serial:  ref.id,
        jarPath: result.jarPath,
        adbPath: result.adbPath,
        reason:  result.reason
      });
      return { canCapture: false, reason: result.reason };
    }

    logger.info('scrcpy-capture probe passed', {
      serial:  ref.id,
      jarPath: result.jarPath,
      adbPath: result.adbPath,
      version: SCRCPY_VERSION
    });

    return {
      canCapture: true,
      format:     'h264-annexb',
      transport:  `scrcpy-v${SCRCPY_VERSION}-mediacodec`,
      jarPath:    result.jarPath
    };
  }

  /**
   * Create and return a ScrcpyCaptureStream for the requested device.
   * The stream must be started by the caller (StreamManager calls .start()).
   */
  async startCapture(handle, options = {}) {
    const serial = handle.ref.id;

    logger.info('Starting scrcpy capture', {
      serial,
      targetClass: handle.ref.targetClass
    });

    return new ScrcpyCaptureStream(serial, options);
  }
}

module.exports = { ScrcpyCaptureProvider };
