'use strict';

/**
 * CoreSimIOSurfaceStream — primary iOS simulator capture.
 *
 * Spawns the native `coresim-capture` helper which reads the CoreSimulator
 * IOSurface framebuffer directly and encodes it with VideoToolbox to Baseline
 * H.264 Annex-B. This stream parses the helper's process protocol and re-emits
 * the same `data` / `ended` events every other capture stream uses, so the
 * StreamManager pipeline is unchanged.
 *
 * Helper process contract (see coresim-capture/main.swift):
 *   stdout : [uint32 BE length][Annex-B access-unit bytes] ...
 *   stderr : line-delimited text — "GEOMETRY {json}", "READY", "LOG ..", "FATAL .."
 *   stdin  : 'K' byte → force an IDR (renegotiation / new subscriber)
 *
 * @module stream/capture/ios/CoreSimIOSurfaceStream
 */

const fs = require('fs');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { streamConfig } = require('../../../lib/config');
const { createLogger } = require('../../../lib/logger');
const { resolveDeviceGeometry } = require('../../../config/iosDeviceSizes');
const { buildCaptureGeometry } = require('../../core/captureGeometry');

const logger = createLogger('CORESIM');

const STALL_MS = parseInt(process.env.CORESIM_STALL_MS, 10) || 8_000;

class CoreSimIOSurfaceStream extends EventEmitter {
  /**
   * @param {string} udid                 simulator UDID
   * @param {object} [opts]
   * @param {string} [opts.deviceTypeIdentifier]
   * @param {number} [opts.fps]
   * @param {number} [opts.bitRate]
   */
  constructor(udid, opts = {}) {
    super();
    this.providerId = 'ios-coresim-iosurface';

    // The helper emits exactly one COMPLETE Annex-B access unit per `data`
    // event (length-prefixed framing parsed in _onStdout), so the H.264
    // processor can drain on real AU boundaries instead of re-deriving them
    // with the idle-gap heuristic. This eliminates the partialPFrameRetained /
    // idlePFrameDrain churn and the partial-frame mis-segmentation that showed
    // up as tearing/overlap on iOS. See StreamManager's frameDelimited wiring.
    this.frameDelimited = true;

    this._udid = udid;
    this._deviceTypeIdentifier = opts.deviceTypeIdentifier || '';
    this._fps = opts.fps || streamConfig.iosFps;
    this._bitrate = opts.bitRate || streamConfig.iosBitrate;
    this._keyframeSec = opts.keyframeSec || streamConfig.iosKeyframeSec;

    this._proc = null;
    this._started = false;
    this._stopped = false;
    this._startedAt = 0;
    this._stallTimer = null;

    // stdout frame parser
    this._buf = Buffer.alloc(0);
    this._need = -1;            // bytes of current frame body, -1 = need header
    // stderr line buffer
    this._errBuf = '';

    this._surfacePixels = null; // { w, h } from helper GEOMETRY
    this._geometry = null;      // CaptureGeometry once known

    this._stats = { bytes: 0, chunks: 0, frames: 0 };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async start() {
    if (this._started) return { success: true };
    this._started = true;
    this._startedAt = Date.now();

    const helper = streamConfig.coresimHelperPath;
    if (!fs.existsSync(helper)) {
      const msg = `coresim-capture helper not found at ${helper}. ` +
        `Build it: bash stream/capture/ios/coresim-capture/build.sh`;
      this._reportEnd('helper_not_found', msg);
      throw new Error(msg);
    }

    const args = [
      '--udid', this._udid,
      '--fps', String(this._fps),
      '--bitrate', String(this._bitrate),
      '--keyframe-interval', String(this._keyframeSec)
    ];
    if (streamConfig.developerDir) {
      args.push('--developer-dir', streamConfig.developerDir);
    }

    logger.info('Starting coresim-capture helper', {
      udid: this._udid, fps: this._fps, bitrate: this._bitrate
    });

    this._proc = spawn(helper, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    this._proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this._proc.stderr.on('data', (chunk) => this._onStderr(chunk));
    this._proc.on('error', (err) => {
      logger.error('coresim helper spawn error', { udid: this._udid, error: err.message });
      this._onExit('spawn_error', err.message);
    });
    this._proc.on('close', (code, signal) => {
      this._onExit('helper_exited', `exit code=${code} signal=${signal}`, code);
    });

    this._armStall();
    return { success: true };
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._clearStall();
    logger.info('coresim capture stopping', { udid: this._udid, stats: this._stats });
    try { this._proc?.kill('SIGTERM'); } catch { /* ignore */ }
    this._proc = null;
  }

  getStatus() {
    return {
      providerId: this.providerId,
      deviceId: this._udid,
      running: this._started && !this._stopped,
      stats: { ...this._stats }
    };
  }

  /** Force the encoder to emit an IDR on the next frame (renegotiation). */
  requestKeyframe() {
    try { this._proc?.stdin.write('K'); } catch { /* ignore */ }
  }

  /** Returns the CaptureGeometry once the helper has reported its surface. */
  getStreamMeta() {
    return this._geometry;
  }

  // ── stdout: length-prefixed Annex-B access units ────────────────────────────

  _onStdout(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      if (this._need < 0) {
        if (this._buf.length < 4) break;
        this._need = this._buf.readUInt32BE(0);
        this._buf = this._buf.subarray(4);
        if (this._need <= 0 || this._need > 32 * 1024 * 1024) {
          logger.warn('coresim invalid frame length — resyncing', { len: this._need });
          this._need = -1;
          this._buf = Buffer.alloc(0);
          break;
        }
      }
      if (this._buf.length < this._need) break;
      const au = Buffer.from(this._buf.subarray(0, this._need));
      this._buf = this._buf.subarray(this._need);
      this._need = -1;
      this._dispatch(au);
    }
  }

  _dispatch(au) {
    if (!au.length) return;
    this._stats.bytes += au.length;
    this._stats.chunks += 1;
    this._stats.frames += 1;
    this._resetStall();
    this.emit('data', au);
  }

  // ── stderr: control / log lines ─────────────────────────────────────────────

  _onStderr(chunk) {
    this._errBuf += chunk.toString('utf8');
    let idx;
    while ((idx = this._errBuf.indexOf('\n')) >= 0) {
      const line = this._errBuf.slice(0, idx).trim();
      this._errBuf = this._errBuf.slice(idx + 1);
      if (line) this._handleControlLine(line);
    }
  }

  _handleControlLine(line) {
    if (line.startsWith('GEOMETRY ')) {
      this._onGeometry(line.slice('GEOMETRY '.length));
    } else if (line.startsWith('READY')) {
      logger.info('coresim helper ready', { udid: this._udid });
    } else if (line.startsWith('FATAL ')) {
      const msg = line.slice('FATAL '.length);
      logger.error('coresim helper fatal', { udid: this._udid, msg });
      // The process will exit; _onExit drives the single-shot teardown.
    } else if (line.startsWith('LOG ') || line.startsWith('PROBE_OK')) {
      logger.debug('coresim helper', { udid: this._udid, line });
    } else {
      logger.debug('coresim helper stderr', { udid: this._udid, line });
    }
  }

  _onGeometry(json) {
    let parsed;
    try { parsed = JSON.parse(json); } catch (err) {
      logger.warn('coresim geometry parse failed', { error: err.message, json });
      return;
    }
    const surface = parsed.capture_surface || {};
    this._surfacePixels = { w: surface.w || 0, h: surface.h || 0 };

    const { logical, scale, source } = resolveDeviceGeometry(
      this._deviceTypeIdentifier, this._surfacePixels
    );

    // Stream is encoded at native surface resolution (no scaling in the helper).
    this._geometry = buildCaptureGeometry({
      provider: this.providerId,
      platform: 'ios',
      targetClass: 'simulator',
      deviceLogical: logical,
      backingScale: scale,
      captureSurface: this._surfacePixels,
      streamSize: this._surfacePixels,
      rotation: 0
    });

    logger.info('coresim geometry resolved', {
      udid: this._udid,
      surface: this._surfacePixels,
      logical,
      scale,
      source
    });
    this.emit('streamMeta', this._geometry);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  _onExit(reason, message, code) {
    if (this._stopped) return;
    this._stopped = true;
    this._clearStall();
    logger.warn('coresim helper ended', { udid: this._udid, reason, message, code });
    this._reportEnd(reason, message);
  }

  _reportEnd(reason, message) {
    this.emit('ended', { reason, message });
  }

  _armStall() {
    this._clearStall();
    this._stallTimer = setTimeout(() => {
      if (this._stopped) return;
      logger.warn('coresim no data — stall', { udid: this._udid, stallMs: STALL_MS });
      this._stopped = true;
      try { this._proc?.kill('SIGKILL'); } catch { /* ignore */ }
      this._reportEnd('stall_no_data', 'No H.264 data within timeout');
    }, STALL_MS);
    if (this._stallTimer.unref) this._stallTimer.unref();
  }

  _resetStall() {
    this._clearStall();
    this._armStall();
  }

  _clearStall() {
    if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null; }
  }
}

/**
 * Static probe: helper present + simulator booted + IOSurface reachable.
 * Runs the helper in --probe mode (exits 0 with PROBE_OK on success).
 *
 * @param {string} udid
 * @returns {Promise<{ok:boolean, reason?:string, surface?:string}>}
 */
async function probeCoreSim(udid) {
  const helper = streamConfig.coresimHelperPath;
  if (!fs.existsSync(helper)) {
    return { ok: false, reason: `coresim-capture helper not built at ${helper}` };
  }
  return new Promise((resolve) => {
    const args = ['--udid', udid, '--probe'];
    if (streamConfig.developerDir) args.push('--developer-dir', streamConfig.developerDir);
    const proc = spawn(helper, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ ok: false, reason: 'probe timed out' });
    }, 8_000);
    if (timer.unref) timer.unref();
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: e.message }); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const m = err.match(/PROBE_OK\s+(\S+)/);
        resolve({ ok: true, surface: m?.[1] });
      } else {
        const fatal = err.split('\n').find((l) => l.startsWith('FATAL '));
        resolve({ ok: false, reason: fatal ? fatal.slice(6) : `probe exit ${code}` });
      }
    });
  });
}

module.exports = { CoreSimIOSurfaceStream, probeCoreSim };
