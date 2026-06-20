'use strict';

/**
 * IdbTranscodeStream — iOS fallback capture (tier 2).
 *
 * Used ONLY when CoreSimIOSurfaceProvider is unavailable (e.g. a future Xcode
 * breaks the private IOSurface API). This path is policy-free: it ALWAYS decodes
 * idb's output and re-encodes to Baseline H.264 Annex-B via ffmpeg, so the wire
 * format is identical to the primary path. There is NO raw idb passthrough.
 *
 *   idb video-stream --format h264   (decode source)
 *       │ stdout (H.264)
 *       ▼
 *   ffmpeg -f h264 -i pipe:0 → libx264 baseline annexb → stdout
 *       │
 *       ▼  emit('data')  (same contract as every capture stream)
 *
 * @module stream/capture/ios/IdbTranscodeStream
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { streamConfig } = require('../../../lib/config');
const { createLogger } = require('../../../lib/logger');
const { resolveDeviceGeometry } = require('../../../config/iosDeviceSizes');
const { buildCaptureGeometry } = require('../../core/captureGeometry');

const logger = createLogger('IDB_TRANSCODE');
const STALL_MS = parseInt(process.env.IDB_STALL_MS, 10) || 10_000;

class IdbTranscodeStream extends EventEmitter {
  constructor(udid, opts = {}) {
    super();
    this.providerId = 'ios-idb-transcode';
    this._udid = udid;
    this._deviceTypeIdentifier = opts.deviceTypeIdentifier || '';
    this._fps = opts.fps || streamConfig.iosFps;
    this._bitrate = opts.bitRate || streamConfig.iosBitrate;
    this._keyframeSec = opts.keyframeSec || streamConfig.iosKeyframeSec;

    this._idb = null;
    this._ffmpeg = null;
    this._started = false;
    this._stopped = false;
    this._stallTimer = null;
    this._geometry = null;
    this._stats = { bytes: 0, chunks: 0, frames: 0, ffmpegStderrErrors: 0 };
  }

  async start() {
    if (this._started) return { success: true };
    this._started = true;

    this._buildGeometry();

    const idbArgs = ['video-stream', '--udid', this._udid, '--fps', String(this._fps), '--format', 'h264'];
    const gop = Math.max(1, this._fps * this._keyframeSec);
    const ffArgs = [
      '-hide_banner', '-loglevel', 'error',
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-f', 'h264', '-i', 'pipe:0',
      '-an',
      '-c:v', 'libx264',
      '-profile:v', 'baseline',
      '-level', '3.1',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-b:v', String(this._bitrate),
      '-g', String(gop), '-keyint_min', String(gop),
      '-x264-params', 'scenecut=0:bframes=0:repeat-headers=1',
      '-bsf:v', 'dump_extra',
      '-f', 'h264', 'pipe:1'
    ];

    logger.info('Starting idb→ffmpeg transcode', { udid: this._udid, fps: this._fps, bitrate: this._bitrate });

    try {
      this._idb = spawn(streamConfig.idbPath, idbArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      this._ffmpeg = spawn(streamConfig.ffmpegPath, ffArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this._reportEnd('spawn_error', err.message);
      throw err;
    }

    this._idb.stdout.pipe(this._ffmpeg.stdin);

    this._idb.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) logger.debug('idb stderr', { udid: this._udid, msg });
    });
    this._idb.on('error', (err) => this._onProcError('idb', err));
    this._idb.on('close', (code) => {
      if (!this._stopped) this._onExit('idb_exited', `idb exit ${code}`);
    });

    this._ffmpeg.stdout.on('data', (chunk) => this._onData(chunk));
    this._ffmpeg.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) {
        this._stats.ffmpegStderrErrors += 1;
        logger.debug('ffmpeg stderr', { udid: this._udid, msg });
      }
    });
    this._ffmpeg.on('error', (err) => this._onProcError('ffmpeg', err));
    this._ffmpeg.on('close', (code) => {
      if (!this._stopped) this._onExit('ffmpeg_exited', `ffmpeg exit ${code}`);
    });

    this._armStall();
    return { success: true };
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._clearStall();
    logger.info('idb transcode stopping', { udid: this._udid, stats: this._stats });
    try { this._idb?.kill('SIGTERM'); } catch { /* ignore */ }
    try { this._ffmpeg?.kill('SIGTERM'); } catch { /* ignore */ }
    this._idb = null;
    this._ffmpeg = null;
  }

  getStatus() {
    return {
      providerId: this.providerId,
      deviceId: this._udid,
      running: this._started && !this._stopped,
      stats: { ...this._stats }
    };
  }

  getStreamMeta() {
    return this._geometry;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  _buildGeometry() {
    const { logical, scale } = resolveDeviceGeometry(this._deviceTypeIdentifier, null);
    // Transcode re-encodes at idb's native resolution; only the aspect ratio
    // matters for client letterboxing and normalized touch maps to logical.
    this._geometry = buildCaptureGeometry({
      provider: this.providerId,
      platform: 'ios',
      targetClass: 'simulator',
      deviceLogical: logical,
      backingScale: scale,
      captureSurface: { w: logical.w * scale, h: logical.h * scale },
      streamSize: { w: logical.w, h: logical.h },
      rotation: 0
    });
    this.emit('streamMeta', this._geometry);
  }

  _onData(chunk) {
    if (!chunk.length) return;
    this._stats.bytes += chunk.length;
    this._stats.chunks += 1;
    this._resetStall();
    this.emit('data', chunk);
  }

  _onProcError(which, err) {
    logger.error(`${which} spawn error`, { udid: this._udid, error: err.message });
    this._onExit(`${which}_spawn_error`, err.message);
  }

  _onExit(reason, message) {
    if (this._stopped) return;
    this._stopped = true;
    this._clearStall();
    logger.warn('idb transcode ended', { udid: this._udid, reason, message });
    try { this._idb?.kill('SIGTERM'); } catch { /* ignore */ }
    try { this._ffmpeg?.kill('SIGTERM'); } catch { /* ignore */ }
    this._idb = null;
    this._ffmpeg = null;
    this._reportEnd(reason, message);
  }

  _reportEnd(reason, message) {
    this.emit('ended', { reason, message });
  }

  _armStall() {
    this._clearStall();
    this._stallTimer = setTimeout(() => {
      if (this._stopped) return;
      logger.warn('idb transcode stall', { udid: this._udid });
      this._onExit('stall_no_data', 'No H.264 data within timeout');
    }, STALL_MS);
    if (this._stallTimer.unref) this._stallTimer.unref();
  }

  _resetStall() { this._clearStall(); this._armStall(); }
  _clearStall() { if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null; } }
}

/**
 * Probe: idb + ffmpeg present and the simulator is booted.
 */
async function probeIdbTranscode(udid) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);

  try {
    await execFileAsync(streamConfig.ffmpegPath, ['-version'], { timeout: 4000 });
  } catch (err) {
    return { ok: false, reason: `ffmpeg not available: ${err.message}` };
  }
  try {
    await execFileAsync(streamConfig.idbPath, ['--help'], { timeout: 4000 });
  } catch (err) {
    return { ok: false, reason: `idb not available: ${err.message}` };
  }
  return { ok: true };
}

module.exports = { IdbTranscodeStream, probeIdbTranscode };
