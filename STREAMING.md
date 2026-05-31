# Streaming architecture

Layered monolith: WebSocket + JSON signaling, HTTP health/stats, **server-side WebRTC (werift)** + **adb screenrecord** capture, desktop decodes with SIPSorcery + FFmpeg.

```
Desktop (recv-only WebRTC)
    ↔ SDP/ICE over WebSocket
Server (werift sendonly H.264 RTP)
    ← adb exec-out screenrecord --output-format=h264
Emulator / device display
```

## Startup state machine (server)

`stream/MediaStartupGate.js` enforces the exact ordering below. Each transition is logged with `Startup state transition`.

```
WAIT_SDP_LOCAL  → offer created
WAIT_SDP_REMOTE → answer received
WAIT_DTLS       → DTLS connected
WAIT_CODEC      → SPS + PPS parsed from screenrecord
SEND_SPS_PPS    → STAP-A bootstrap written to wire (no VCL yet)
WAIT_DECODER    → STREAM_DECODER_WARMUP_MS (default 500 ms)
STREAMING       → gate open, IDR + P-frames allowed via pacer
```

Invariants:

| Invariant | Mechanism |
|-----------|-----------|
| No RTP video before WAIT_DTLS | `_sendBootstrapRtp` and `_sendRtp` both check DTLS / gate |
| SPS + PPS first on the wire | `_flushParamSetsAndOpenGate` sends STAP-A and **then** advances the RTP timestamp |
| STAP-A never bundled with IDR | `streamProcessor.flushAccessUnit` emits IDR-only access units; rejects any packet whose first byte is NAL type 24 |
| Decoder gets warm-up time | `_startDecoderWarmup` holds the pacer disabled for `STREAM_DECODER_WARMUP_MS` |
| Segment restart re-bootstraps | `_handleSegmentRestart` resets `paramSetsFlushed` / `decoderReady`, capture re-emits SPS/PPS, gate re-runs |
| Optional periodic refresh | `STREAM_PARAM_REFRESH_MS` > 0 → STAP-A re-sent every N ms (no VCL bundled) |

## First 5 seconds — expected log timeline

```
t=0     [SIGNALING] offer created                    → state: wait_sdp_remote
t≈100ms [PEER] SDP answer applied                    → state: wait_dtls
t≈200ms [PEER] sender DTLS connected                 → state: wait_codec
t≈500ms [STREAM_MGR] codec params ready              → state: send_sps_pps
t≈501ms [STREAM_MGR] STAP-A bootstrap flushed        → state: wait_decoder
t≈1001ms [STREAM_MGR] decoder warm-up elapsed        → state: streaming
t≈1050ms [STREAM_MGR] first IDR access unit emitted  (IDR only, own timestamp)
t≈1050ms→ paced P-frames at fps
```

## Receiver (`EmulatorDesktopApp`)

`Services/WebRTCClient.cs`:

1. `OnVideoFrameReceived` arrives from SIPSorcery already-reassembled per RTP timestamp.
2. `ExpandPayloadForDecoder` splits the payload into one or two clean Annex-B feeds:
   - STAP-A bootstrap → one feed with `[0001 SPS][0001 PPS]`.
   - Standalone IDR → one feed with `[0001 IDR]`.
   - Legacy combined frame (not produced by current server) → `[params][VCL]`.
3. `UpdateParamSetFlags` marks `_h264ParamsReady` and logs `SPS received` / `PPS received`.
4. `CanFeedPayload` only blocks IDR/P feeds that arrive before SPS/PPS were seen. STAP-A / SPS / PPS feeds are never dropped.
5. Each feed → `FFmpegVideoEndPoint.GotVideoFrame` → render slot.

## Server modules

| File | Role |
|------|------|
| `server.js` | Message router: `start_stream`, `webrtc_answer`, `ice_candidate`, `control` |
| `stream/StreamManager.js` | Startup state machine, pacer, RTP emit gating |
| `stream/MediaStartupGate.js` | Explicit gate state machine + `tryOpen` |
| `stream/FramePacer.js` | Per-fps pacer; disabled until gate `STREAMING` |
| `stream/webrtc/PeerConnection.js` | werift sendonly video |
| `stream/capture/ScreenrecordCapture.js` | Continuous H.264 from adb |
| `stream/media/h264/*` | Annex-B parse, SPS/PPS cache, RFC 6184 packetize (single NAL + FU-A + STAP-A) |
| `control/ControlRouter.js` | `adb shell input` tap/swipe/key |

## Run

```bash
cd websocket_nodejs/adb-emulator-server && npm install && npm start

cd EmulatorDesktopApp && dotnet run
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STREAM_WIDTH` / `STREAM_HEIGHT` | `480 × 854` | screenrecord size |
| `STREAM_FPS` | `20` | RTP / pacer target |
| `STREAM_RECORD_BITRATE` | `2000000` | screenrecord bit-rate |
| `SCREENRECORD_TIME_LIMIT` | `180` | adb screenrecord segment (auto-restart) |
| `STREAM_MIN_IDR_BYTES` | `8192` | Min IDR size after first frame |
| `STREAM_FIRST_IDR_MIN_BYTES` | `2048` | Lower bar for the first keyframe |
| `STREAM_DRAIN_IDLE_MS` | `400` | Emit stalled trailing IDR after this idle gap |
| `STREAM_KEYFRAMES_ONLY` | `false` | IDR-only stream (no P-frame ghosts; lower FPS) |
| `STREAM_IDR_DEDUP_MS` | `2500` | Suppress duplicate small IDRs only |
| `STREAM_CODEC_WAIT_MS` | `30000` | Wait for SPS/PPS from capture before opening gate |
| `STREAM_DECODER_WARMUP_MS` | `500` | Hold first IDR after STAP-A flush (100–2000 ms) |
| `STREAM_PARAM_REFRESH_MS` | `0` | If > 0, re-send STAP-A every N ms for resilience |
| `FFMPEG_PATH` | `ffmpeg` | Desktop decode |
| `ADB_PATH` | `adb` | Device capture + control |

## Removed

- `android-stream-agent/` — superseded by server screenrecord + desktop WebRTC.
