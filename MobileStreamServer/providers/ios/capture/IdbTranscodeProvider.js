'use strict';

/**
 * iOS fallback capture provider (tier 2): idb → ffmpeg Baseline transcode.
 * Policy-free; always outputs Baseline H.264 Annex-B. Never raw idb passthrough.
 *
 * @module providers/ios/capture/IdbTranscodeProvider
 */

const { PLATFORMS } = require('../../../platform/types');
const { IdbTranscodeStream, probeIdbTranscode } = require('../../../stream/capture/ios/IdbTranscodeStream');
const { createLogger } = require('../../../lib/logger');

const logger = createLogger('IDB_TRANSCODE_PROV');

class IdbTranscodeProvider {
  constructor() {
    this.providerId = 'ios-idb-transcode';
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
    const result = await probeIdbTranscode(ref.id);
    if (!result.ok) {
      return { canCapture: false, reason: result.reason };
    }
    logger.info('idb transcode probe passed', { udid: ref.id });
    return { canCapture: true, format: 'h264-annexb', transport: 'idb-ffmpeg-baseline' };
  }

  async startCapture(handle, options = {}) {
    const udid = handle.ref.id;
    const deviceTypeIdentifier = handle.ref.metadata?.deviceTypeIdentifier
      || handle.ref.deviceTypeIdentifier || '';
    logger.info('Starting idb transcode capture', { udid });
    return new IdbTranscodeStream(udid, {
      deviceTypeIdentifier,
      fps: options.fps,
      bitRate: options.bitRate
    });
  }
}

module.exports = { IdbTranscodeProvider };
