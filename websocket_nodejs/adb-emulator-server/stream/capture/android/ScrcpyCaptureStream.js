/**
 * Android H.264 capture via scrcpy-server.
 *
 * WHY SCRCPY INSTEAD OF adb screenrecord
 * ────────────────────────────────────────
 * adb screenrecord is a high-level tool that internally applies software
 * H.264 encoding, rate-limits the frame rate, and adds overhead from process
 * startup + pipe buffering.  It is inherently unreliable for long sessions
 * (exits after 3–5 minutes) and produces burst-then-idle patterns.
 *
 * scrcpy-server is a purpose-built Android streaming daemon with:
 *   • Zero FFmpeg re-encode: MediaCodec hardware H.264 via AMediaCodec, same
 *     path used by Android's own screen recording APIs.
 *   • Native H.264 Annex-B output: frames arrive pre-formatted, compatible
 *     with our streamProcessor pipeline without any additional processing.
 *   • Persistent session: the server runs until explicitly stopped; no 3-minute
 *     timeout, no restart overhead.
 *   • Per-frame metadata: PTS + CONFIG/KEY_FRAME flags allow accurate IDR
 *     detection without Annex-B NAL type parsing.
 *   • Low latency: no pipe buffering — the server writes each encoded frame
 *     directly to the TCP socket the moment MediaCodec delivers it.
 *
 * PROTOCOL OVERVIEW (scrcpy v2.7)
 * ─────────────────────────────────
 * 1. Push scrcpy-server.jar to /data/local/tmp/ on the device.
 * 2. Forward a host TCP port to the device's abstract socket:
 *      adb -s <serial> forward tcp:<port> localabstract:scrcpy
 * 3. Launch the server in the background via adb shell:
 *      CLASSPATH=/data/local/tmp/scrcpy-server.jar \
 *      app_process / com.genymobile.scrcpy.Server 2.7 \
 *        video_codec=h264 max_size=... video_bit_rate=... ...
 * 4. Connect a TCP socket to localhost:<port>.
 * 5. Read the device-info header (68 bytes v1.x / 76 bytes v2.x), then iterate over frame packets:
 *      [pts: uint64 BE][size: uint32 BE][H.264 Annex-B data: size bytes]
 *
 * PTS FLAGS (encoded in high bits of the 8-byte PTS field):
 *   Bit 63 = 0x8000000000000000 → CONFIG frame (SPS + PPS Annex-B)
 *   Bit 62 = 0x4000000000000000 → KEY_FRAME (IDR; mutually exclusive with CONFIG)
 *   Bits 0–61 → actual presentation timestamp in microseconds
 *
 * CONFIG frames carry the initial SPS + PPS and must be forwarded to the
 * streamProcessor before any VCL frame.  They arrive at session start and
 * again whenever the encoder reconfigures (e.g. orientation change).
 *
 * ENVIRONMENT VARIABLES
 * ─────────────────────
 * SCRCPY_SERVER_JAR     Path to scrcpy-server.jar.
 *                       Defaults to <project-root>/scrcpy/scrcpy-server.jar.
 *                       Download: https://github.com/Genymobile/scrcpy/releases
 * SCRCPY_PORT           Base TCP port for forwarding (default: 27183).
 *                       Each concurrent device session uses a separate port
 *                       derived from this base plus a session slot index.
 * SCRCPY_MAX_SIZE       Encoder max dimension (default: 1080, from ANDROID_MAX_SIZE).
 * SCRCPY_BITRATE        Video bitrate bps (default: 8M, from ANDROID_STREAM_BITRATE).
 * SCRCPY_MAX_FPS        Encoder FPS cap (default: 30).
 * SCRCPY_STALL_MS       No-DATA stall timeout ms (default: 30000). Any byte
 *                       (CONFIG keepalive or VCL) resets it. This is a
 *                       "socket truly dead" safety net only — a static screen
 *                       legitimately produces no VCL frames and must NOT be
 *                       treated as a stall (that caused a reconnect loop).
 *                       Interaction-without-frame recovery is driven by
 *                       StreamManager via requestRecovery(), not this timer.
 * SCRCPY_MAX_STALL_RECOVERIES  Reconnect attempts before fatal (default: 10).
 * SCRCPY_CONNECT_TIMEOUT_MS  Socket connect attempt timeout (default: 10000).
 *
 * @module stream/capture/android/ScrcpyCaptureStream
 */

'use strict';

const net     = require('net');
const path    = require('path');
const fs      = require('fs');
const { EventEmitter } = require('events');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { streamConfig } = require('../../../lib/config');
const { createLogger } = require('../../../lib/logger');
const { queryDisplaySize } = require('./input');

const execFileAsync = promisify(execFile);
const logger = createLogger('SCRCPY');

// ── Constants ─────────────────────────────────────────────────────────────────

// Absolute path to scrcpy-server.jar.
// __dirname = <root>/websocket_nodejs/adb-emulator-server/stream/capture/android
// ../../../  = <root>/websocket_nodejs/adb-emulator-server   ← project root
// So the jar lives at: adb-emulator-server/scrcpy/scrcpy-server.jar
const SERVER_JAR_PATH = process.env.SCRCPY_SERVER_JAR
  ? path.resolve(process.env.SCRCPY_SERVER_JAR)
  : path.resolve(__dirname, '../../../scrcpy/scrcpy-server.jar');

// scrcpy-server version — MUST match the JAR file.
// v1.x (≤1.25): uses `bit_rate=` arg names; device-info header = 68 bytes.
// v2.x (≥2.0): uses `video_bit_rate=`, `audio=false`; device-info header = 76 bytes
//              (added 4-byte codec_id + int32 width/height instead of uint16).
// Override: SCRCPY_VERSION=1.25 npm start
const SCRCPY_VERSION  = process.env.SCRCPY_VERSION || '2.7';
const BASE_PORT       = parseInt(process.env.SCRCPY_PORT,            10) || 27183;
const CONNECT_TIMEOUT = parseInt(process.env.SCRCPY_CONNECT_TIMEOUT_MS, 10) || 10_000;

function resolveCaptureTuning(opts = {}) {
  const maxSize = opts.maxSize
    || parseInt(process.env.SCRCPY_MAX_SIZE, 10)
    || streamConfig.androidMaxSize
    || 1080;
  const bitrate = opts.bitRate
    || opts.bitrate
    || parseInt(process.env.SCRCPY_BITRATE, 10)
    || streamConfig.androidBitrate
    || 8_000_000;
  const maxFps = opts.fps
    || opts.maxFps
    || parseInt(process.env.SCRCPY_MAX_FPS, 10)
    || streamConfig.androidFps
    || streamConfig.fps
    || 30;
  return { maxSize, bitrate, maxFps };
}

// Safety net for a genuinely dead socket only. A static Android screen produces
// no VCL frames by design (MediaCodec emits on change), so the watchdog must be
// DATA-based and generous — any byte resets it. Reconnecting on mere video idle
// tears down a healthy capture and produces a reconnect loop on idle screens.
const STALL_MS = parseInt(process.env.SCRCPY_STALL_MS, 10) || 30_000;
const MAX_STALL_RECOVERIES = parseInt(process.env.SCRCPY_MAX_STALL_RECOVERIES, 10) || 10;

// Per-process port allocator: each active ScrcpyCaptureStream gets a unique port
// from a pool so concurrent sessions on different devices don't collide.
const _activePorts = new Set();
function _allocPort() {
  for (let offset = 0; offset < 20; offset++) {
    const p = BASE_PORT + offset;
    if (!_activePorts.has(p)) { _activePorts.add(p); return p; }
  }
  throw new Error(`All scrcpy port slots in use (${BASE_PORT}–${BASE_PORT + 19})`);
}
function _freePort(p) { _activePorts.delete(p); }

// PTS flag masks (BigInt).
const FLAG_CONFIG    = BigInt('0x8000000000000000');
const FLAG_KEYFRAME  = BigInt('0x4000000000000000');

// Device-info header sizes by protocol version:
//
// v1.x: 68 bytes
//   [name: 64 B][width: uint16 BE][height: uint16 BE]
//
// v2.x: 76 bytes  ← added codec_id; width/height widened to int32
//   [name: 64 B][codec_id: uint32 BE = 'h264'][width: int32 BE][height: int32 BE]
//
// Confirmed empirically: raw connection to v2.7 server yields 80 bytes before
// the first CONFIG frame header, of which bytes 0–75 are the device meta and
// bytes 76–79 are the high-order 4 bytes of the CONFIG PTS (0x80000000...).
const DEVICE_INFO_BYTES = parseInt(SCRCPY_VERSION, 10) >= 2 ? 76 : 68;

// ── ScrcpyCaptureStream ───────────────────────────────────────────────────────

class ScrcpyCaptureStream extends EventEmitter {
  /**
   * @param {string} serial   ADB device serial (emulator-5554, etc.)
   * @param {object} [opts]
   * @param {string} [opts.adbPath]   Override adb binary path.
   */
  constructor(serial, opts = {}) {
    super();
    this._serial    = serial;
    this._adb       = opts.adbPath || 'adb';
    this._port      = null;     // allocated on start()
    this._socket    = null;     // TCP socket to scrcpy server
    this._shellProc = null;     // adb shell process (keeps server running)
    this._stopped   = false;
    this._recovering = false;
    this._started   = false;
    this._startedAt = 0;
    this._stallTimer = null;
    this._lastVclAt  = 0;

    // Frame parser state machine
    this._parseState = 'DEVICE_INFO';  // → 'FRAME_HEADER' → 'FRAME_DATA'
    this._parseBuf   = Buffer.alloc(0);
    this._frameSize  = 0;
    this._framePts   = BigInt(0);

    // Video + touch geometry (device info header + wm size).
    this._videoWidth = 0;
    this._videoHeight = 0;
    this._displayWidth = 0;
    this._displayHeight = 0;

    const tuning = resolveCaptureTuning(opts);
    this._maxSize = tuning.maxSize;
    this._bitrate = tuning.bitrate;
    this._maxFps = tuning.maxFps;

    this._stats = {
      bytes: 0, chunks: 0, frames: 0,
      configFrames: 0, keyFrames: 0,
      stallRecoveries: 0
    };

    this.providerId = 'scrcpy-capture';
  }

  // ── Public API ───────────────────────────────────────────────────────────

  async start() {
    if (this._started) return;
    this._started  = true;
    this._startedAt = Date.now();
    this._lastVclAt = this._startedAt;

    // Validate the jar.
    if (!fs.existsSync(SERVER_JAR_PATH)) {
      const err = new Error(
        `scrcpy-server.jar not found at ${SERVER_JAR_PATH}. ` +
        `Download scrcpy v${SCRCPY_VERSION} from ` +
        `https://github.com/Genymobile/scrcpy/releases and place the jar at ` +
        `that path, or set SCRCPY_SERVER_JAR env var.`
      );
      this._reportEnd('jar_not_found', err.message);
      throw err;
    }

    try {
      this._port = _allocPort();
      await this._killExistingServer();
      await this._pushJar();
      await this._forwardPort();
      this._startServer();
      await this._connectSocket();
      return { success: true };
    } catch (err) {
      logger.error('scrcpy startup failed', { serial: this._serial, error: err.message });
      await this._cleanup();
      this._reportEnd('startup_error', err.message);
      throw err;
    }
  }

  stop() {
    if (this._stopped) return Promise.resolve();
    this._stopped = true;
    this._clearStall();
    logger.info('scrcpy capture stopping', { serial: this._serial, stats: this._stats });
    return this._stopAndCleanup();
  }

  async _stopAndCleanup() {
    await this._cleanup();
    await this._killExistingServer();
  }

  getStatus() {
    return {
      providerId: 'scrcpy-capture',
      deviceId:   this._serial,
      running:    this._started && !this._stopped,
      stats:      { ...this._stats }
    };
  }

  /**
   * Stream + device geometry for the desktop coordinate mapper.
   * stream_* = encoded video size; device_logical_* = `wm size` for adb input.
   */
  getStreamMeta() {
    if (this._videoWidth <= 0 || this._videoHeight <= 0) return null;
    const dw = this._displayWidth || this._videoWidth;
    const dh = this._displayHeight || this._videoHeight;
    return {
      provider: 'scrcpy-capture',
      platform: 'android',
      coordinate_space: 'device_logical',
      stream_width: this._videoWidth,
      stream_height: this._videoHeight,
      device_logical_width: dw,
      device_logical_height: dh,
      rotation: 0,
      cropped: false
    };
  }

  async _ensureDisplaySize() {
    if (this._displayWidth > 0 && this._displayHeight > 0) return;
    try {
      const ds = await queryDisplaySize(this._serial);
      this._displayWidth = ds.width;
      this._displayHeight = ds.height;
      const meta = this.getStreamMeta();
      if (meta) this.emit('streamMeta', meta);
    } catch (err) {
      logger.warn('Failed to query Android display size', { serial: this._serial, error: err.message });
    }
  }

  // ── Setup helpers ─────────────────────────────────────────────────────────

  /**
   * Push the server jar to the device.
   * Uses `adb push --sync` so it is skipped if the file is already up-to-date.
   */
  async _pushJar() {
    logger.info('Pushing scrcpy-server.jar', { serial: this._serial, jar: SERVER_JAR_PATH });
    const t0 = Date.now();
    await execFileAsync(this._adb, [
      '-s', this._serial,
      'push', '--sync',
      SERVER_JAR_PATH,
      '/data/local/tmp/scrcpy-server.jar'
    ], { timeout: 15_000 });
    logger.info('scrcpy-server.jar pushed', { serial: this._serial, ms: Date.now() - t0 });
  }

  /**
   * Forward a host TCP port to the device's scrcpy abstract socket.
   * With tunnel_forward=true the server LISTENS on the abstract socket;
   * the client connects via the forwarded host port.
   */
  async _forwardPort() {
    if (this._port == null) {
      throw new Error('scrcpy port not allocated before forward');
    }

    // Defensively remove any stale forward on this port before (re-)binding.
    // Leftover forwards from a crashed or stalled previous session can cause
    // the new client to connect to a dead socket and receive socket_end instantly.
    try {
      await execFileAsync(this._adb, [
        '-s', this._serial,
        'forward', '--remove', `tcp:${this._port}`
      ], { timeout: 3_000 });
      logger.info('scrcpy removed stale port forward', { serial: this._serial, port: this._port });
    } catch {
      // No existing forward — expected on first use, safe to ignore.
    }

    await execFileAsync(this._adb, [
      '-s', this._serial,
      'forward',
      `tcp:${this._port}`,
      'localabstract:scrcpy'
    ], { timeout: 5_000 });
    logger.info('scrcpy port forwarded', { serial: this._serial, port: this._port });
  }

  /**
   * Launch the scrcpy server as a background shell process.
   * stderr is piped at INFO level so startup errors (ClassNotFound, SELinux
   * denials, wrong JAR version) are always visible in server logs.
   */
  _startServer() {
    // Build version-aware argument list.
    // v1.x (≤1.x): positional args, `bit_rate=` (no `video_` prefix), no audio flag.
    // v2.x (≥2.0): named args, `video_bit_rate=`, `video_codec=h264`, `audio=false`.
    const majorVersion = parseInt(SCRCPY_VERSION, 10);
    const isV2 = majorVersion >= 2;

    const serverArgs = isV2
      ? [
          'video_codec=h264',
          `max_size=${this._maxSize}`,
          `video_bit_rate=${this._bitrate}`,
          `max_fps=${this._maxFps}`,
          'tunnel_forward=true',
          'send_frame_meta=true',
          'control=false',
          'audio=false',
          'send_dummy_byte=false'
        ]
      : [
          `max_size=${this._maxSize}`,
          `bit_rate=${this._bitrate}`,
          `max_fps=${this._maxFps}`,
          'tunnel_forward=true',
          'send_frame_meta=true',
          'control=false',
          'send_dummy_byte=false'
        ];

    const args = [
      '-s', this._serial,
      'shell',
      'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      SCRCPY_VERSION,
      ...serverArgs
    ];

    logger.info('Starting scrcpy server', {
      serial:        this._serial,
      port:          this._port,
      jar:           SERVER_JAR_PATH,
      version:       SCRCPY_VERSION,
      argFormat:     isV2 ? 'v2 (video_bit_rate / audio=false)' : 'v1 (bit_rate)',
      maxSize:       this._maxSize,
      bitrate:       this._bitrate,
      maxFps:        this._maxFps
    });

    this._shellProc = spawn(this._adb, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    this._shellProc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      // Always log at INFO — stderr from the scrcpy server carries startup
      // confirmation ("INFO: Device: ...") as well as fatal crash messages.
      if (msg) logger.info('scrcpy server stderr', { serial: this._serial, msg });
    });

    this._shellProc.on('close', (code) => {
      logger.info('scrcpy server shell exited', { serial: this._serial, code });
      if (this._recovering || this._stopped) return;
      this._recoverFromStall().catch((err) => {
        logger.error('scrcpy recovery after shell exit failed', { serial: this._serial, error: err.message });
        this._fatalEnd('server_exited', `scrcpy server shell exited (code=${code})`);
      });
    });
  }

  /**
   * Poll for the forwarded socket until the scrcpy server accepts connections.
   * The server needs ~200–500 ms after the shell command to start.
   */
  async _connectSocket() {
    const deadline = Date.now() + CONNECT_TIMEOUT;
    let lastErr = null;

    while (Date.now() < deadline) {
      if (this._stopped) throw new Error('stopped before socket connected');

      try {
        await this._tryConnect();
        return; // Connected!
      } catch (err) {
        lastErr = err;
        await new Promise(r => setTimeout(r, 150));
      }
    }

    throw new Error(
      `scrcpy socket connect timed out after ${CONNECT_TIMEOUT} ms ` +
      `(last error: ${lastErr?.message})`
    );
  }

  /**
   * Try once to connect to the forwarded port AND confirm the server is alive
   * by waiting for the first data byte.
   *
   * ADB forward silently accepts the TCP connection and then immediately sends
   * EOF when the device-side abstract socket (`localabstract:scrcpy`) is not
   * bound yet — i.e. while the scrcpy server is still starting up.  Resolving
   * on the raw `connect` event therefore gives a false "connected" signal that
   * turns into an instant `socket_end` error before any stream data arrives.
   *
   * By waiting for the first `data` event we guarantee:
   *   1. The TCP path to ADB is working.
   *   2. The device-side abstract socket is bound.
   *   3. The scrcpy server has started and is streaming.
   *
   * A `close` or `end` before any data is treated as a retryable "not ready"
   * condition so the caller's poll loop keeps trying.
   */
  _tryConnect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port: this._port });
      let done = false;

      const cleanup = () => {
        sock.removeListener('error',  onError);
        sock.removeListener('close',  onPrematureClose);
        sock.removeListener('end',    onPrematureEnd);
        sock.removeListener('data',   onFirstData);
      };

      const onError = (err) => {
        if (done) return; done = true;
        cleanup(); sock.destroy(); reject(err);
      };

      // Premature close/end before any data = abstract socket not bound yet.
      const onPrematureClose = () => {
        if (done) return; done = true;
        cleanup(); sock.destroy();
        reject(new Error('premature close — scrcpy abstract socket not ready yet'));
      };
      const onPrematureEnd = () => {
        if (done) return; done = true;
        cleanup(); sock.destroy();
        reject(new Error('premature end — scrcpy abstract socket not ready yet'));
      };

      // First data byte proves the server is alive and streaming.
      const onFirstData = (chunk) => {
        if (done) return; done = true;
        cleanup();
        // Wire the socket for all subsequent events.
        this._socket = sock;
        this._wireSocket();
        // Replay the first chunk through the frame parser
        // (it has already been consumed from the stream).
        if (chunk.length > 0) this._onSocketData(chunk);
        resolve();
      };

      sock.once('error',  onError);
      sock.once('close',  onPrematureClose);
      sock.once('end',    onPrematureEnd);
      sock.once('data',   onFirstData);
      // No 'connect' listener needed — we gate on data, not on TCP handshake.
    });
  }

  // ── Socket data handling ──────────────────────────────────────────────────

  _wireSocket() {
    const sock = this._socket;

    sock.on('data',  (chunk) => this._onSocketData(chunk));
    sock.on('end',   ()      => this._onSocketClose('socket_end'));
    sock.on('close', ()      => this._onSocketClose('socket_close'));
    sock.on('error', (err)   => {
      logger.warn('scrcpy socket error', { serial: this._serial, error: err.message });
      this._onSocketClose('socket_error');
    });

    logger.info('scrcpy socket connected', { serial: this._serial, port: this._port });
    this._lastVclAt = Date.now();
    this._armStall();
  }

  _onSocketData(chunk) {
    this._parseBuf = this._parseBuf.length
      ? Buffer.concat([this._parseBuf, chunk])
      : chunk;

    // Drain as many complete logical units as possible from the buffer.
    for (;;) {
      if (this._parseState === 'DEVICE_INFO') {
        if (this._parseBuf.length < DEVICE_INFO_BYTES) break;

        const name = this._parseBuf.slice(0, 64).toString('utf8').replace(/\0+$/, '');

        let width, height, codecId;
        if (DEVICE_INFO_BYTES === 76) {
          // v2.x: [name 64B][codec_id uint32 BE 4B][width int32 BE 4B][height int32 BE 4B]
          // codec_id = 0x68323634 = 'h264' in ASCII
          codecId = this._parseBuf.readUInt32BE(64).toString(16);
          width   = this._parseBuf.readInt32BE(68);
          height  = this._parseBuf.readInt32BE(72);
        } else {
          // v1.x: [name 64B][width uint16 BE 2B][height uint16 BE 2B]
          width  = this._parseBuf.readUInt16BE(64);
          height = this._parseBuf.readUInt16BE(66);
        }

        this._parseBuf = this._parseBuf.slice(DEVICE_INFO_BYTES);
        this._parseState = 'FRAME_HEADER';

        this._videoWidth = width;
        this._videoHeight = height;
        void this._ensureDisplaySize();

        logger.info('scrcpy device info received', {
          serial: this._serial, deviceName: name, codecId, width, height
        });
        continue;
      }

      if (this._parseState === 'FRAME_HEADER') {
        if (this._parseBuf.length < 12) break;
        this._framePts  = this._parseBuf.readBigUInt64BE(0);
        this._frameSize = this._parseBuf.readUInt32BE(8);
        this._parseBuf  = this._parseBuf.slice(12);
        this._parseState = 'FRAME_DATA';
        continue;
      }

      if (this._parseState === 'FRAME_DATA') {
        if (this._parseBuf.length < this._frameSize) break;

        const frameData = Buffer.from(this._parseBuf.slice(0, this._frameSize));
        this._parseBuf  = this._parseBuf.slice(this._frameSize);
        this._parseState = 'FRAME_HEADER';

        this._dispatchFrame(frameData, this._framePts);
        continue;
      }

      break; // unknown state — should never happen
    }
  }

  _dispatchFrame(data, ptsRaw) {
    if (!data.length) return;

    const isConfig   = (ptsRaw & FLAG_CONFIG)   !== BigInt(0);
    const isKeyframe = (ptsRaw & FLAG_KEYFRAME)  !== BigInt(0);

    this._stats.bytes  += data.length;
    this._stats.chunks += 1;
    this._stats.frames += 1;
    if (isConfig)   this._stats.configFrames++;
    if (isKeyframe) this._stats.keyFrames++;

    // Any byte from the socket — including CONFIG keepalives — proves the
    // capture process is alive, so it resets the "socket dead" watchdog.
    // _lastVclAt tracks real video separately for telemetry / input-stall logic.
    if (!isConfig) this._lastVclAt = Date.now();
    this._resetStall();

    // Emit the raw H.264 Annex-B bytes; streamProcessor.js handles SPS/PPS
    // extraction, IDR gating, and RTP packetization exactly as it does for
    // adb-screenrecord / scrcpy direct pipe.
    this.emit('data', data);
  }

  // ── Stall watchdog ────────────────────────────────────────────────────────

  /**
   * On-demand recovery hook for StreamManager. Used when the user interacted
   * (input injected) but no new video frame followed within the grace window —
   * i.e. the encoder is genuinely stuck. NOT used for plain video idle, which
   * is normal for a static screen.
   */
  requestRecovery(reason = 'requested') {
    if (this._stopped || this._recovering) return Promise.resolve();
    logger.info('scrcpy recovery requested', { serial: this._serial, reason });
    this._clearStall();
    return this._recoverFromStall();
  }

  _armStall() {
    this._clearStall();
    this._stallTimer = setTimeout(() => {
      if (this._stopped || this._recovering) return;
      // Data-based: any byte resets via _resetStall, so reaching here means the
      // socket delivered nothing at all for STALL_MS — the process is dead.
      this._recoverFromStall().catch((err) => {
        logger.error('scrcpy stall recovery threw', { serial: this._serial, error: err.message });
        this._fatalEnd('stall_no_data', 'No data from scrcpy socket within timeout');
      });
    }, STALL_MS);
    if (this._stallTimer.unref) this._stallTimer.unref();
  }

  /**
   * Reconnect scrcpy after a no-data stall (static screen / background).
   * Only becomes fatal after MAX_STALL_RECOVERIES attempts.
   */
  async _recoverFromStall() {
    this._stats.stallRecoveries++;
    if (this._stats.stallRecoveries > MAX_STALL_RECOVERIES) {
      this._fatalEnd(
        'stall_no_data',
        `No H.264 data after ${MAX_STALL_RECOVERIES} capture recovery attempts`
      );
      return;
    }

    logger.warn('scrcpy no data — reconnecting capture', {
      serial:         this._serial,
      stallTimeoutMs: STALL_MS,
      attempt:        this._stats.stallRecoveries,
      maxAttempts:    MAX_STALL_RECOVERIES,
      stats:          this._stats
    });

    this._recovering = true;
    try {
      this._clearStall();
      await this._cleanupForRecovery();

      this._parseState = 'DEVICE_INFO';
      this._parseBuf     = Buffer.alloc(0);
      this._frameSize    = 0;
      this._framePts     = BigInt(0);

      const port = _allocPort();
      this._port = port;
      await this._killExistingServer();
      await this._pushJar();
      await this._forwardPort();
      this._startServer();
      await this._connectSocket();
      this._lastVclAt = Date.now();
      this.emit('recovered', { attempt: this._stats.stallRecoveries, reason: 'stall_no_data' });
    } finally {
      this._recovering = false;
    }
  }

  _fatalEnd(reason, message) {
    if (this._stopped) return;
    this._stopped = true;
    this._clearStall();
    this._cleanup().catch(() => {});
    this._reportEnd(reason, message);
  }

  _resetStall() {
    this._clearStall();
    this._armStall();
  }

  _clearStall() {
    if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null; }
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────

  _onSocketClose(reason) {
    if (this._stopped || this._recovering) return;
    logger.warn('scrcpy socket closed — attempting recovery', { serial: this._serial, reason });
    this._recoverFromStall().catch((err) => {
      logger.error('scrcpy recovery after socket close failed', { serial: this._serial, error: err.message });
      this._fatalEnd(reason, `scrcpy socket closed (${reason})`);
    });
  }

  /**
   * Kill any scrcpy-server process that is still running on the device from a
   * previous session.  Without this, the abstract socket `localabstract:scrcpy`
   * stays bound by the zombie and the new client receives an immediate
   * `socket_end` when it connects.
   *
   * `pkill` exits with code 1 when there is nothing to kill — that is normal.
   */
  async _killExistingServer() {
    await killOrphanedScrcpyOnDevice(this._serial, this._adb);
  }

  async _cleanupForRecovery() {
    try { this._socket?.destroy(); } catch { /* ignore */ }
    this._socket = null;

    const proc = this._shellProc;
    this._shellProc = null;
    if (proc) {
      proc.removeAllListeners();
      proc.stderr?.removeAllListeners();
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }

    if (this._port !== null) {
      const port = this._port;
      this._port = null;
      execFile(this._adb, [
        '-s', this._serial,
        'forward', '--remove', `tcp:${port}`
      ], () => {});
      _freePort(port);
    }
  }

  async _cleanup() {
    // Tear down: socket, adb shell, port forward (best-effort, don't throw).
    try { this._socket?.destroy(); } catch { /* ignore */ }
    this._socket = null;

    try { this._shellProc?.kill('SIGTERM'); } catch { /* ignore */ }
    if (this._shellProc) {
      this._shellProc.removeAllListeners();
      this._shellProc.stderr?.removeAllListeners();
    }
    this._shellProc = null;

    if (this._port !== null) {
      // Remove the port forward so the port can be reused.
      execFile(this._adb, [
        '-s', this._serial,
        'forward', '--remove', `tcp:${this._port}`
      ], () => {});
      _freePort(this._port);
      this._port = null;
    }
  }

  _reportEnd(reason, message) {
    // 'ended' matches the convention used by every other capture stream so
    // StreamManager.capture.on('ended', ...) fires correctly.
    this.emit('ended', { reason, message });
  }
}

// ── Static probe: is scrcpy usable for this device? ──────────────────────────

/**
 * Quick prerequisite check used by ScrcpyCaptureProvider.probe().
 * Verifies: jar file present, adb binary reachable, device online.
 *
 * @param {string} serial     ADB device serial (e.g. 'emulator-5554')
 * @returns {{ ok: boolean, reason?: string, jarPath?: string, adbPath?: string }}
 */
async function probeScrcpy(serial) {
  // Resolve the adb binary path from env / config so ADB_PATH overrides are honoured.
  // IMPORTANT: never call path.resolve on a bare command name like 'adb' — that
  // produces ${CWD}/adb, which only works when the Android SDK is literally in the
  // working directory.  Only resolve when the value looks like an actual path.
  const rawAdb  = streamConfig.adbPath || 'adb';
  const adbPath = rawAdb.includes(path.sep) ? path.resolve(rawAdb) : rawAdb;

  // ── 1. Jar presence ────────────────────────────────────────────────────────
  // Resolve to absolute path so the error message always shows the full path,
  // never a misleading relative one.
  const jarAbsPath = path.resolve(SERVER_JAR_PATH);

  if (!fs.existsSync(jarAbsPath)) {
    return {
      ok:      false,
      jarPath: jarAbsPath,
      adbPath,
      reason:
        `scrcpy-server.jar not found at: ${jarAbsPath}. ` +
        `Run the one-time setup:\n` +
        `  mkdir -p "${path.dirname(jarAbsPath)}"\n` +
        `  curl -L https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION} \\\n` +
        `       -o "${jarAbsPath}"\n` +
        `Or set SCRCPY_SERVER_JAR=/absolute/path/to/scrcpy-server.jar`
    };
  }

  // ── 2. ADB binary check ────────────────────────────────────────────────────
  try {
    await execFileAsync(adbPath, ['version'], { timeout: 3000 });
  } catch (err) {
    return {
      ok:      false,
      jarPath: jarAbsPath,
      adbPath,
      reason:  `adb binary not found or not executable at "${adbPath}": ${err.message}. ` +
               `Set ADB_PATH=/path/to/adb or add Android SDK platform-tools to PATH.`
    };
  }

  // ── 3. Device reachability ─────────────────────────────────────────────────
  // Explicitly target the device with -s <serial> so multi-device environments
  // don't silently connect to the wrong device.
  try {
    await execFileAsync(adbPath, ['-s', serial, 'shell', 'echo', 'scrcpy_probe_ok'], { timeout: 5000 });
  } catch (err) {
    return {
      ok:      false,
      jarPath: jarAbsPath,
      adbPath,
      reason:  `adb -s ${serial} shell echo failed: ${err.message}. ` +
               `Device may be offline, unauthorized, or the serial is wrong.`
    };
  }

  return { ok: true, jarPath: jarAbsPath, adbPath };
}

/**
 * Kill any orphaned scrcpy server on the device and wait for MediaCodec /
 * `localabstract:scrcpy` to be released before a new capture session starts.
 */
async function killOrphanedScrcpyOnDevice(serial, adbPath = 'adb') {
  const patterns = ['scrcpy-server', 'com.genymobile.scrcpy'];
  let killed = false;

  for (const pattern of patterns) {
    try {
      await execFileAsync(adbPath, [
        '-s', serial,
        'shell', 'pkill', '-KILL', '-f', pattern
      ], { timeout: 3_000 });
      killed = true;
    } catch {
      // pkill exits 1 when nothing matches — normal on a clean device.
    }
  }

  // Emulator MediaCodec needs a beat to tear down after pkill.
  await new Promise((r) => setTimeout(r, killed ? 500 : 150));

  if (killed) {
    logger.info('Killed orphaned scrcpy server on device', { serial });
  }
}

module.exports = {
  ScrcpyCaptureStream,
  probeScrcpy,
  killOrphanedScrcpyOnDevice,
  SERVER_JAR_PATH,
  SCRCPY_VERSION
};
