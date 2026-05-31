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
  recordBitrate: parseIntEnv('STREAM_RECORD_BITRATE', 6_000_000),

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
  adbPath: process.env.ADB_PATH || 'adb'
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
