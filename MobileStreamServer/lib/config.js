/**
 * Stream and device configuration.
 *
 * Tuning the visible quality / latency trade-off
 * ----------------------------------------------
 * Three knobs matter:
 *
 *   STREAM_RECORD_BITRATE  — the H.264 bitrate handed to `screenrecord`.
 *     The previous default (2 Mbps) was the dominant source of visible block
 *     corruption / "pixelation" on 720p captures: MediaCodec aggressively
 *     drops detail to stay under budget and discards high-frequency content
 *     in motion. 6 Mbps at 720p (or 8 Mbps at 1080p) renders cleanly without
 *     stressing the encoder's frame-time budget.
 *
 *   STREAM_FPS — pacer + RTP timestamp rate. Higher fps reduces tap-to-pixel
 *     latency (each frame slot is 1/fps ms wide) but raises encoder load.
 *     30 fps is the sweet spot for screen mirroring: 33 ms slots, smooth
 *     enough to follow scroll, modest encoder pressure.
 *
 *   STREAM_LOW_LATENCY — when true, prefers smaller buffers / lower bitrate.
 *     This was the *cause* of the pixelation reported by the user (it was
 *     halving the bitrate to 2 Mbps), so it now only affects pacer tuning,
 *     not encoder bitrate. Encoder quality should never be sacrificed
 *     silently for latency — bitrate is exposed as its own knob.
 */

function parseIntEnv(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

function envBool(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return v === 'true' || v === '1' || v === 'yes';
}

const streamConfig = {
  width: parseIntEnv('STREAM_WIDTH', 720),
  height: parseIntEnv('STREAM_HEIGHT', 1280),
  fps: parseIntEnv('STREAM_FPS', 30),
  bitrate: process.env.STREAM_BITRATE || '6M',
  codec: 'h264',

  /**
   * MediaCodec target bitrate for `adb screenrecord --bit-rate=...`.
   *
   * 6 Mbps @ 720p / 30 fps gives ~3.3 KB per inter-coded frame on average —
   * comfortable headroom for an Android phone home screen with text and
   * icons (the previous 2 Mbps default starved the encoder and produced the
   * blocky output the user reported).
   *
   * Raise to 8–12 Mbps for 1080p captures or content-heavy screens (games,
   * media playback). Beyond 12 Mbps the wire bandwidth becomes the bottleneck
   * on Wi-Fi.
   */
  recordBitrate: parseIntEnv('STREAM_RECORD_BITRATE', 8_000_000),

  // ── Android-specific capture tuning ─────────────────────────────────────
  // scrcpy MediaCodec: max_size limits the LONG edge; bitrate drives blockiness.
  //
  // SHARPNESS / "pixel quality"
  // ───────────────────────────
  // max_size scales so the device's LONGER dimension == max_size. A portrait
  // 1080×2400 panel at max_size=1080 is therefore squashed to ~486×1080 before
  // encoding — that downscale (not the codec) is the dominant cause of soft
  // text and pixelation. Raising it to 1600 captures ~720×1600 (≈1.5× linear
  // resolution, much crisper) while staying under the H.264 Level 4.1 frame
  // budget (~2.0 MP): 720×1600 ≈ 1.15 MP, safe. Going full-native (1080×2400 ≈
  // 2.6 MP) would exceed L4.1 and force the encoder to bump level or fail, so
  // we cap here. Lower via ANDROID_MAX_SIZE if the emulator host can't sustain
  // the higher pixel rate (you'll trade fps for resolution).
  androidMaxSize:  parseIntEnv('ANDROID_MAX_SIZE', 1600),
  androidWidth:    parseIntEnv('ANDROID_STREAM_WIDTH',   1080),
  androidHeight:   parseIntEnv('ANDROID_STREAM_HEIGHT',  2400),

  // COLOR / BLOCKINESS
  // ──────────────────
  // Higher bitrate = fewer quantization artifacts = cleaner gradients (less
  // colour banding) and sharper edges. 6 Mbps was tuned for the old ~486-wide
  // capture; at the higher 1600 max_size it would starve the encoder and
  // reintroduce blocking, so we raise to 8 Mbps to match the extra pixels.
  // Because the WebRTC path has no retransmission, larger frames are slightly
  // more loss-prone — keep ≤10 Mbps on Wi-Fi. Override with
  // ANDROID_STREAM_BITRATE.
  androidBitrate:  parseIntEnv('ANDROID_STREAM_BITRATE', 8_000_000),
  androidFps:      parseIntEnv('ANDROID_STREAM_FPS', 30),

  /**
   * MediaCodec keyframe (IDR) interval in seconds for scrcpy capture.
   *
   * WHY THIS MATTERS — "frame overlapping" / ghosting fix
   * ────────────────────────────────────────────────────
   * The WebRTC video path is H.264 over UDP with NO retransmission guarantee.
   * scrcpy's encoder defaults to a ~10 s keyframe interval and, on a static
   * screen, may emit only ONE IDR for the whole session. When a single RTP
   * packet is lost, every subsequent P-frame predicts from a now-wrong
   * reference, so updated regions paint over stale ones (visible "overlapping"
   * / smearing) and never self-correct until the next IDR — which could be
   * 30–60 s away.
   *
   * Forcing a short IDR cadence (1 s) bounds that corruption window to ~1 s:
   * the picture fully refreshes every second regardless of loss. Passed to the
   * encoder via scrcpy `video_codec_options=i-frame-interval:int=N`.
   *
   * Set to 0 to omit the option entirely (use the encoder default). Raise to
   * 2–3 to reduce keyframe bandwidth overhead at the cost of slower recovery.
   */
  androidKeyframeSec: parseIntEnv('ANDROID_KEYFRAME_SEC', 1),

  // ── iOS-specific capture tuning ─────────────────────────────────────────
  // CoreSimulator capture is native-resolution (no max_size); width/height are
  // informational only. fps + bitrate drive the VideoToolbox encoder.
  iosFps:           parseIntEnv('IOS_STREAM_FPS', 30),
  iosBitrate:       parseIntEnv('IOS_STREAM_BITRATE', 6_000_000),
  iosKeyframeSec:   parseIntEnv('IOS_KEYFRAME_INTERVAL_SEC', 1),
  // Helper + tool paths.
  coresimHelperPath: process.env.CORESIM_HELPER_PATH ||
    require('path').resolve(__dirname, '../stream/capture/ios/coresim-capture/coresim-capture'),
  idbPath:          process.env.IDB_PATH || 'idb',
  developerDir:     process.env.DEVELOPER_DIR || '',

  /**
   * `screenrecord --time-limit` value (seconds).
   *
   * Per the single-shot capture contract the encoder is started exactly ONCE
   * per session and is NEVER respawned. When this limit elapses the entire
   * session is torn down and the desktop is asked to reconnect — there is no
   * partial media-pipeline restart. We therefore pick a long ceiling so a
   * normal session runs to completion under the user's control.
   *
   * Note: historic Android `screenrecord` binaries clamped to 180s. Modern
   * (Android 10+) builds accept much larger values. Override with
   * SCREENRECORD_TIME_LIMIT if your device has the legacy cap.
   */
  screenrecordTimeLimit: parseIntEnv('SCREENRECORD_TIME_LIMIT', 86400),
  keyframesOnly: envBool('STREAM_KEYFRAMES_ONLY', false),
  useTestPattern: process.env.USE_TEST_PATTERN === 'true',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  // Resolved dynamically at load (ADB_PATH → PATH → ANDROID_HOME → common SDK paths).
  get adbPath() {
    return require('./resolveAdb').getAdbPath();
  }
};

function resolveStreamOptions(overrides = {}) {
  return {
    width: overrides.width || streamConfig.width,
    height: overrides.height || streamConfig.height,
    fps: overrides.fps || streamConfig.fps,
    bitrate: overrides.bitrate || streamConfig.bitrate,
    codec: 'h264'
  };
}

module.exports = { streamConfig, resolveStreamOptions, parseIntEnv, envBool };
