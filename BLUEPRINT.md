# Android Emulator Remote Control & Streaming Platform — System Blueprint

> Complete technical specification for re-implementing the system from scratch.
> This document is the source of truth; do not reference the existing codebase
> while rebuilding. Every requirement in this document is mandatory unless
> explicitly marked optional.

---

## 1. Project Overview

The system is a real-time **Android emulator remote control & screen-streaming platform**. A single Node.js gateway exposes a WebSocket API that:

- Lifecycle-manages Android emulators / physical devices through ADB.
- Captures the device screen as an H.264 elementary stream via `adb exec-out screenrecord`.
- Streams that H.264 bitstream as **server-originated WebRTC** (one-way send-only video) to a desktop client.
- Routes pointer / key / text events from the desktop back to the device via `adb shell input`.

The desktop client is a cross-platform .NET / Avalonia application. It opens a WebSocket, completes a WebRTC handshake, depacketizes RTP using SIPSorcery, decodes H.264 with FFmpeg, and renders frames in a dedicated window. Pointer events on the video surface are mapped to **normalized (0..1) coordinates** and posted back over the WebSocket.

The platform is engineered for **correctness first, latency second**. The hardest engineering problem solved here is the H.264 startup race between the encoder (server) and the decoder (client) — it is described in detail in §6 and §7.

### 1.1 High-level goals

| Goal | Requirement |
|------|-------------|
| Single connection per client | One WebSocket, one WebRTC peer, one device |
| Push, not pull | Server originates the WebRTC offer |
| Codec | H.264 only (Constrained Baseline 3.1, `profile-level-id=42e01f`, packetization-mode 1) |
| Resolution | 480 × 854 default, configurable |
| Frame rate | 20 fps default, configurable |
| First-frame budget | ≤ 1500 ms from `webrtc_answer` to first decoded picture |
| End-to-end latency | ≤ 250 ms steady-state (LAN / loopback) |
| Robustness | No corrupted first frame, no decoder desync, no `non-existing PPS` errors |

---

## 2. High-Level Architecture

```
+----------------------+        WebSocket (JSON)         +-----------------------+
|   Desktop App        | <-----------------------------> |   Node.js Gateway     |
|   (Avalonia, .NET)   |   signaling + control plane     |                       |
|                      |                                 |   Session Manager     |
|   - SIPSorcery PC    |                                 |   Stream Manager      |
|   - FFmpegVideoEndPt |       RTP over DTLS-SRTP        |   Media Startup Gate  |
|   - Render pipeline  | <=============================  |   H.264 Stream Proc.  |
|   - UI (XAML)        |     (server -> desktop only)    |   RFC 6184 packetizer |
+----------------------+                                 |   ADB Bridge          |
                                                          +-----------+-----------+
                                                                      | adb exec-out
                                                                      | screenrecord
                                                                      | + adb shell input
                                                                      v
                                                          +-----------------------+
                                                          |  Android Emulator /   |
                                                          |  USB Device           |
                                                          +-----------------------+
```

Three independent channels run between desktop and server:

| Channel | Transport | Direction | Payload |
|---------|-----------|-----------|---------|
| Signaling | WebSocket (JSON) | bidirectional | session lifecycle, SDP, ICE, control events |
| Video | WebRTC RTP / DTLS-SRTP | **server → desktop only** | H.264 NAL units (RFC 6184) |
| Control | WebSocket (JSON) | desktop → server | tap / swipe / key / text |

The WebRTC peer is **sendonly** on the server side and **recvonly** on the desktop side.

### 2.1 End-to-end data flow (happy path)

```
1.  Desktop ws.connect("ws://server:8080")          ── WS ──>  Server.createSession()
2.            <─ {type:"connected", session_id}    <── WS ──   Server
3.  Desktop {type:"create_session", device:"AVD"}  ── WS ──>  Server.emulatorManager.start()
4.            <─ {type:"session_created"}          <── WS ──   Server
5.  Desktop {type:"start_stream"}                  ── WS ──>  Server.streamManager.startStream()
                                                              ├─ create RTCPeerConnection (sendonly, H.264 only)
                                                              ├─ spawn adb screenrecord (parse-only mode)
                                                              ├─ create H.264 parser + RFC 6184 packetizer
                                                              ├─ createOffer() / setLocalDescription()
                                                              └─ MediaStartupGate: WAIT_SDP_LOCAL → WAIT_SDP_REMOTE
6.            <─ {type:"stream_started", webrtc_offer:{sdp}}
7.  Desktop  setRemoteDescription(offer)
             createAnswer() / setLocalDescription()
             onicecandidate fires repeatedly        ── WS ──>  Server.peer.addIceCandidate()
8.  Desktop {type:"webrtc_answer", sdp}            ── WS ──>  MediaStartupGate: WAIT_DTLS
9.  Server peer.onicecandidate                      ── WS ──>  Desktop.peer.addIceCandidate()
10. DTLS handshake completes                        ──────>   MediaStartupGate: WAIT_CODEC
11. SPS + PPS parsed from screenrecord              ──────>   MediaStartupGate: SEND_SPS_PPS
12. STAP-A bootstrap RTP packet sent                ── RTP ─>  Desktop FFmpeg accepts params
13. Warm-up timer (default 500ms) elapses           ──────>   MediaStartupGate: STREAMING
14. First IDR (FU-A fragmented) sent                ── RTP ─>  Desktop decodes first picture
15. Paced P-frames + occasional IDR                 ── RTP ─>  steady-state streaming

Control plane (anytime after step 4):
    Desktop {type:"control", event:{action:"tap", x:0.5, y:0.5}} ── WS ──>
        Server.controlRouter.handleControl()
            → ScreenrecordCapture.injectInput()
            → adb -s <id> shell input tap <px> <py>
```

---

## 3. Node.js Server Architecture

### 3.1 Process layout

A **single Node.js process** runs:

- One HTTP server (`/health`, `/stats`) for liveness probes.
- One WebSocket server (`ws` package) that accepts client connections.
- One **werift** `RTCPeerConnection` per active stream (pure-JS WebRTC implementation; no native deps).
- One child process per active capture: `adb -s <deviceId> exec-out screenrecord --output-format=h264 --size=W×H --bit-rate=B --time-limit=N -`.

There is no inter-process IPC and no clustering. Each session is fully serialised on the WebSocket message chain to prevent `ice_candidate` from racing `start_stream`.

### 3.2 Module map

```
adb-emulator-server/
├── server.js                       # HTTP + WS entrypoint; message router
├── sessionManager.js               # Session lifecycle + ws ↔ session ↔ device map
├── emulator.js / emulatorManager.js# AVD list, start, stop, ownership
├── adb.js                          # `adb devices`, `adb shell ...` shell-out helpers
├── webrtcSignaling.js              # SDP / ICE state snapshot per session (telemetry)
│
├── control/
│   ├── ControlRouter.js            # tap/swipe/key/text → active ScreenrecordCapture
│   └── input.js                    # `adb shell input` mapping (denormalization)
│
├── lib/
│   ├── config.js                   # streamConfig (size, fps, bitrate, paths)
│   └── logger.js                   # Tag-prefixed console logger
│
└── stream/
    ├── index.js                    # Public exports
    ├── StreamManager.js            # Pipeline orchestrator (one entry per session)
    ├── MediaStartupGate.js         # Strict state-machine gate
    ├── FramePacer.js               # 1-frame slot; latest-wins per fps tick
    │
    ├── capture/
    │   ├── factory.js              # createCapture()
    │   └── ScreenrecordCapture.js  # Spawns `adb screenrecord`, emits 'data' chunks
    │
    ├── webrtc/
    │   └── PeerConnection.js       # werift PC manager; H.264 codec injection; sendRtp()
    │
    └── media/h264/
        ├── index.js
        ├── h264AnnexBParser.js     # Find start codes, split NAL units
        ├── h264AvccParser.js       # Length-prefixed AVCC (if screenrecord ever outputs MP4)
        ├── h264SliceHeader.js      # parseFirstMbInSlice for AU boundary detection
        ├── appendBuffer.js         # rolling byte buffer for streaming chunks
        ├── paramSetCache.js        # Per-session SPS/PPS cache; canEmitIdr()
        ├── streamProcessor.js      # NAL → Access Unit → RTP frame queue
        └── h264RtpPacketizer.js    # RFC 6184: single NAL / FU-A / STAP-A builders
```

### 3.3 Module responsibilities

#### 3.3.1 `server.js`
- Boots HTTP + WS, runs heartbeat (`ws.ping` every 30 s) and stale-session sweeper.
- Owns the `messageHandlers` dictionary (one async function per JSON `type`).
- Wraps each message in a per-connection `Promise` chain so messages are processed **strictly in order** for a given socket. This prevents an `ice_candidate` from being applied before `start_stream` has finished creating the peer.
- Cleans up emulator + WebRTC peer on socket close. If `KILL_EMULATOR_ON_DISCONNECT=true` (default) and the session owns the emulator, it is shut down.

#### 3.3.2 `sessionManager.js`
- Allocates a UUIDv4 per WebSocket.
- Maintains `sessions: Map<sessionId, Session>` and `deviceToSession: Map<deviceId, sessionId>`.
- `Session` has helpers `send`, `sendSuccess`, `sendError` that serialise JSON envelopes with `{ type, success, data, timestamp, requestId? }`.
- Devices are exclusive: a device can be bound to at most one session at a time.

#### 3.3.3 `emulatorManager.js` (briefly)
- Starts emulators via the Android SDK `emulator` command, polls `adb devices` until the new device is **online** and `getprop sys.boot_completed=1`.
- Tracks `ownsEmulator` so the gateway only stops emulators it started itself.

#### 3.3.4 `stream/StreamManager.js`
The brain of the streaming layer. One entry per session: `{ capture, ctx, packetizer, gate, pacer, deliverFrame, pacerStarted, ...timers }`.

Lifecycle methods (mandatory order):
1. `startStream(session, options)`
   - `peerConnectionManager.createPeer(sessionId)` (sendonly, H.264 only).
   - `capture = createCapture(deviceId, {width, height, bitRate, fps})`; `capture.start()`.
   - Build `H264RtpPacketizer`, `EventEmitter`, processor `state` (with `paramSetCache` initialized).
   - `gate = createMediaStartupGate(sessionId)`.
   - Subscribe to capture `data` → `processH264Chunk` → emits `frame` / `keyframe` / `paramSets` / `sceneCut` / `firstFrame` / `codecParamsReady` events on the emitter.
   - **Do not** allow any RTP yet: `ctx.options.emitRtp = false`, `pacer.setEnabled(false)`.
   - `peer.createOffer()` → mark `gate.sdpLocalReady = true`.
   - Return `{ success, offer, mode: 'server_webrtc_screenrecord' }`.

2. `handleAnswer(sessionId, answer)`
   - `peer.setRemoteDescription(answer)` → mark `gate.sdpRemoteReady = true`.
   - `peer.requestPipelineStart(sessionId)`: queue or immediately invoke `_startPipeline`.

3. `addIceCandidate(sessionId, candidate)`
   - Apply to peer if `remoteDescription` is set; otherwise queue.

4. `_startPipeline(sessionId)` (fired when DTLS is ready)
   - `await peer.waitForMediaReady(sessionId, 15000)` → mark `gate.dtlsReady = true`.
   - `await _waitForCodecParams(entry, sessionId)` (poll up to 30 s for SPS+PPS in cache) → mark `gate.codecParamsReady = true`.
   - `await _tryCompleteStartup(sessionId)`:
     - If all four flags ready → `_flushParamSetsAndOpenGate`.
     - `_flushParamSetsAndOpenGate` builds STAP-A (SPS+PPS only), sends it on its own RTP timestamp via `_sendBootstrapRtp`, **advances `state.nextRtpTimestamp` by one fps step** (so the next VCL frame is on its own timestamp), then calls `_startDecoderWarmup`.
     - `_startDecoderWarmup` disables the pacer, sets a timer for `STREAM_DECODER_WARMUP_MS` (default 500 ms, range 100–2000 ms). When it fires, it marks `gate.decoderReady = true` and calls `_openGateForVcl`.
     - `_openGateForVcl` flips `gate.open = true`, enables the pacer, drains any frames queued in `state.pendingRtpFrames`, and starts the periodic Annex-B drain (`tickAnnexBDrain`, every 100 ms).

5. `deliverFrame(frame)` (called from emitter or pacer drain)
   - If `gate.open` is false → drop.
   - If `frame.isParamSetsOnly` → send STAP-A via `_sendRtp`.
   - If `frame.isKeyframe`:
     - Require `state.paramSetsRtpSent === true` (bootstrap already on wire).
     - Require `gate.paramSetsFlushed && gate.decoderReady`.
     - Then `pacer.submit(frame)`.
   - Else (P-frame) → require `state.gotFirstKeyframe === true`, then `pacer.submit(frame)`.

6. `_handleSegmentRestart` (when `adb screenrecord` time-limit elapses or process exits):
   - Reset `paramSetCache`, `pacer`, gate codec phase (`resetCodecPhase`), pending frames.
   - Capture re-emits SPS/PPS → gate runs again from `WAIT_CODEC`.

7. `stopStream(sessionId)`
   - Drain leftover NALs, stop pacer, kill `adb screenrecord` (SIGKILL).
   - `peer.closePeer(sessionId)`, unregister control runtime.

#### 3.3.5 `stream/MediaStartupGate.js`
Pure state machine, no I/O. Exports:

```js
const STATE = {
  WAIT_SDP_LOCAL, WAIT_SDP_REMOTE, WAIT_DTLS, WAIT_CODEC,
  SEND_SPS_PPS, WAIT_DECODER, STREAMING
};

createMediaStartupGate(sessionId) → {
  sessionId, lastState: 'wait_sdp_local',
  sdpLocalReady, sdpRemoteReady, dtlsReady, codecParamsReady,
  paramSetsFlushed, decoderReady, open
}

markFlag(gate, flag, value, reason)   // flip + log state transition
currentState(gate)                    // derives state from flags
tryOpen(gate, reason)                 // open iff all six flags true; returns newly-opened
resetCodecPhase(gate, reason)         // for screenrecord segment restart
snapshot(gate)                        // serialisable view for logging / stats
```

**Invariant: VCL RTP is illegal in any state other than `STREAMING`.** Tested by `StreamManager._sendRtp` which short-circuits when `gate.open === false`.

#### 3.3.6 `stream/FramePacer.js`
- A one-slot, latest-wins buffer with a `setInterval` running at `1000/fps` ms.
- `submit(frame)` overwrites the slot (drop-stat++). `_flush()` fires `onTick(frame)` once per tick when enabled.
- Disabled until gate opens; never holds more than one frame.

#### 3.3.7 `stream/webrtc/PeerConnection.js`
Wraps werift `RTCPeerConnection`:

- Codec list is **forced** to `[useH264({ payloadType: 97, parameters: 'packetization-mode=1;profile-level-id=42e01f' })]` on every offer/answer to defeat werift's VP8 default.
- `ensureH264OnlySdp(sdp)` strips any VP8 rtpmap/fmtp/rtcp-fb lines and rewrites the `m=video` payload list as a safety net.
- `_attachSenderReady` subscribes to `sender.onReady` and `sender.dtlsTransport.onStateChange`; when DTLS reaches `connected`, fires `_onMediaReady(sessionId)` (StreamManager uses this to flip `gate.dtlsReady`).
- `sendFrame(sessionId, rtpPackets)` iterates packets, calling `videoSender.sendRtp(RtpPacket.deSerialize(buf))`. Each Buffer in `rtpPackets` is a fully-built RTP packet (12-byte header + payload) produced by `h264RtpPacketizer`.

#### 3.3.8 `stream/capture/ScreenrecordCapture.js`
- Spawns `adb -s <deviceId> exec-out screenrecord --output-format=h264 --size=WxH --bit-rate=B --time-limit=N -`.
- On `data` chunk → emits `data` to the StreamManager.
- On exit with code != 0 and `restarts <= 8` → emits `segmentRestart` and respawns after 400 ms.
- `injectInput(event)` calls `control/input.js#injectInput(deviceId, displaySize, event)` (see §8).

#### 3.3.9 `stream/media/h264/*` — H.264 stream processor (see §6 for full spec)

| File | Role |
|------|------|
| `h264AnnexBParser.js` | `findStartCodes`, `extractNals` (emulation-prevention aware), `nalType` |
| `h264AvccParser.js` | length-prefixed NAL extraction (used if first chunk header says `ftyp` MP4) |
| `h264SliceHeader.js` | `parseFirstMbInSlice` to detect access-unit boundaries between slices |
| `appendBuffer.js` | rolling `Buffer` accumulator |
| `paramSetCache.js` | per-session SPS/PPS storage + `canEmitIdr()` |
| `streamProcessor.js` | parse → process NALs (SPS/PPS before VCL) → assemble AU → RFC 6184 frame |
| `h264RtpPacketizer.js` | RFC 6184 builders |

---

## 4. Desktop App Architecture

### 4.1 Stack

- **.NET 10** + **Avalonia 12** (cross-platform XAML UI; macOS, Windows, Linux).
- **SIPSorcery 10.0.7** — WebRTC peer, RTP depacketization, SDP handling.
- **SIPSorceryMedia.FFmpeg 10.0.7** — FFmpeg binding for H.264 decode (links Homebrew or system `libav*` at runtime).
- **System.Net.WebSockets** — signaling and control transport.

### 4.2 Module map

```
EmulatorDesktopApp/
├── App.axaml / App.axaml.cs           # Avalonia application bootstrap
├── Program.cs                         # Entrypoint
│
├── MainWindow.axaml(.cs)              # Control panel (connection, devices, sessions, stream)
├── StreamWindow.axaml(.cs)            # Dedicated video + input window
│
├── Services/
│   ├── WebSocketService.cs            # ClientWebSocket wrapper
│   ├── ServerMessageJson.cs           # JSON envelope helpers
│   ├── RemoteControlService.cs        # tap/swipe/key/text sender
│   ├── WebRTCClient.cs                # SIPSorcery PC + FFmpegVideoEndPoint + H.264 feed shaping
│   ├── VideoFrameConverter.cs         # YUV/BGR/RGB → BGRA32 conversion
│   ├── VideoFrameInfo.cs              # Pooled decoded frame container
│   └── StreamMetrics.cs               # Rolling decode/render FPS counter
│
├── Streaming/
│   ├── MirrorSession.cs               # Composition root: WebRTCClient + VideoRenderPipeline
│   ├── VideoRenderPipeline.cs         # latest-frame slot + worker convert + UI present
│   └── LatestFrameSlot.cs             # Mutex-protected single-slot buffer
│
└── ViewModels/
    ├── MainWindowViewModel.cs         # Master state machine + command wiring
    ├── StreamWindowViewModel.cs       # Per-frame UI binding + input coordinate normalization
    └── Commands/RelayCommands.cs      # ICommand implementations
```

### 4.3 Render path (must be implemented exactly as described)

```
SIPSorcery RTP depacketizer
    │ OnVideoFrameReceived(remoteEP, timestamp, byte[] payload, format)
    ▼
WebRTCClient
    │ LogPayloadShape(payload)            // first 3 frames only, hex dump + classification
    │ ExpandPayloadForDecoder(payload)    // → 1 or 2 clean Annex-B feeds
    │ UpdateParamSetFlags(feed)           // cache SPS/PPS, set _h264ParamsReady
    │ CanFeedPayload(feed)                // gate: SPS/PPS/STAP-A always; IDR/P only if params seen
    ▼
FFmpegVideoEndPoint.GotVideoFrame(remoteEP, ts, feed, format)
    │ OnVideoSinkDecodedSampleFaster(RawImage)   // decoded BGR24 picture
    ▼
WebRTCClient.HandleDecodedVideoFrame
    │ OnDecodedRawFrame?.Invoke(rawImage)
    ▼
MainWindowViewModel handler
    │ StreamMetrics.RecordDecoded()
    │ Render.SubmitDecoded(rawImage)
    ▼
VideoRenderPipeline.SubmitDecoded
    │ frame = VideoFrameInfo.FromRawImage(rawImage)   // ★ ALWAYS COPIES ★
    │ _slot.Set(frame)                                // latest wins
    │ _frameSignal.Set()
    │
    │ (Worker thread loop)
    │ DrainLatestFrame()
    │ ConvertToBackBuffer(frame)          // BGR24 → BGRA32 row-by-row into _back
    │ SwapBuffers()                       // (_front, _back) = (_back, _front)
    │ RequestUiPresent()
    ▼
Dispatcher.UIThread.Post(RunUiPump)
    │ PresentLatest(generation)
    │ _bitmap.Lock() → CopyBgraToLocked(_front, _bitmap)
    │ _target.UpdateFrame(_bitmap, inPlaceUpdate:true)
    │ StreamWindow.InvalidateVideoFrame()
```

**Critical correctness rule (proved by debugging):** `VideoFrameInfo.FromRawImage` **must** copy `rawImage.GetBuffer()` (or `rawImage.Sample`) into a private `ArrayPool<byte>` buffer. SIPSorcery / FFmpeg reuse the same `AVFrame` data plane for every subsequent decoded picture; if a reference is held, the next decode overwrites in-place and the renderer reads pixels mid-write, producing ghost / overlapping frames. **Never store a reference to a SIPSorcery-owned buffer.**

### 4.4 WebRTCClient.cs — payload-shaping requirements

The reception path in `OnVideoFrameReceived` is SIPSorcery's already-reassembled "encoded frame" — one full frame's worth of NAL data per RTP timestamp. SIPSorcery may hand us one of three shapes:

1. **Annex-B byte stream** — `00 00 00 01` start codes between NALs.
2. **Raw STAP-A aggregate** — first byte's NAL type is 24 (RFC 6184 §5.7.1).
3. **Single raw NAL unit** — first byte is a NAL header, no start code prefix.

`ExpandPayloadForDecoder(byte[] payload)` must produce **clean Annex-B feeds** suitable for FFmpeg, with these rules:

| Input contents | Output feeds (each Annex-B `00 00 00 01 + NAL`) |
|----------------|-------------------------------------------------|
| Only SPS + PPS (from STAP-A bootstrap) | `[SPS][PPS]` → 1 feed |
| Only IDR | Re-inject cached SPS+PPS in front: `[SPS][PPS][IDR]` |
| Only P-frame(s) | `[P]` |
| SPS+PPS + IDR in the same payload (legacy / safety) | Two feeds: `[SPS][PPS]` and `[SPS][PPS][IDR]` |

Implementation:
- `ExtractAllNals(payload)` first tries `ExtractAnnexBNals`; if any NAL has type 24 (STAP-A), unwrap with `UnwrapStapA`. If no Annex-B NALs are found and the first byte is NAL type 24, treat the whole payload as a raw STAP-A and unwrap. Otherwise the payload is one raw NAL.
- `UnwrapStapA(buf, startOffset)`: walks 2-byte length-prefixed NALs.
- `BuildAnnexBAccessUnit(IList<byte[]> nals)`: writes `0x00 0x00 0x00 0x01` before each NAL.
- `UpdateParamSetFlags(feed)`: when it sees a NAL of type 7 (SPS) or 8 (PPS), it clones the bytes into `_cachedSpsNal` / `_cachedPpsNal` under `_paramSetLock`. Once both are non-null, `_h264ParamsReady = true`.
- `CanFeedPayload(feed)`: accept all feeds containing SPS/PPS. Accept IDR/P only if `_h264ParamsReady` or if the feed itself contains SPS/PPS.

Lifecycle clears (`InitializePeerAsync`, `ClosePeer`, `NotifySceneCut`) must reset `_cachedSpsNal`, `_cachedPpsNal`, `_loggedSps`, `_loggedPps`, `_h264ParamsReady`.

### 4.5 Scene-cut handling

Server sends `{ type: "scene_cut" }` when a new large IDR is detected mid-stream. Desktop ignores the message **until the first frame has been decoded** (`_decodePublished > 0`); otherwise we'd reset the decoder before the bootstrap IDR ever rendered. On a real scene cut, clear cached SPS/PPS, dispose+recreate `FFmpegVideoEndPoint`, clear render slot, and re-enter the same SPS-then-IDR sequence.

---

## 5. Streaming Pipeline (full specification)

### 5.1 End-to-end timeline (first 1.5 s)

```
t=0      [WS]    start_stream                            → server.streamManager.startStream
t≈10ms   [WS]    stream_started{webrtc_offer}            → desktop.peer.setRemoteDescription(offer)
t≈20ms   [WS]    webrtc_answer                           → server.gate.sdpRemoteReady=true
t≈50ms   [ICE]   trickle ICE                              ↔
t≈200ms  [DTLS]  sender DTLS connected                   → server.gate.dtlsReady=true
t≈400ms  [H264]  SPS+PPS parsed from screenrecord stdout → server.gate.codecParamsReady=true
t≈401ms  [RTP]   STAP-A(SPS,PPS) sent (own timestamp)    → server.gate.paramSetsFlushed=true
                                                          ↳ next state: WAIT_DECODER
                                                          ↳ pacer disabled, emitRtp=false
                                                          ↳ FFmpeg ingests SPS/PPS, configures decoder
t≈901ms  [TIMER] STREAM_DECODER_WARMUP_MS elapses        → server.gate.decoderReady=true
                                                          ↳ gate.open=true (STREAMING)
                                                          ↳ pacer enabled, drain pending frames
t≈920ms  [RTP]   First IDR access unit (FU-A fragmented) → desktop FFmpeg decodes
t≈930ms  [UI]    First present 480x854                   → user sees first frame
t≈950ms+ [RTP]   P-frames at fps                          → steady-state
```

### 5.2 Annex-B NAL parsing (server)

`extractNals(buffer)` requirements:
- Scans for `00 00 01` (3-byte) and `00 00 00 01` (4-byte) start codes.
- **Skips** the emulation-prevention pattern `00 00 03` so it's never mistaken for a start code.
- Requires a **following** start code to delimit a NAL; the trailing bytes (after the last start code) are returned as `remainder` so a partial NAL is never emitted.

### 5.3 Access unit (AU) assembly

`processAnnexBNal(ctx, nal)`:
- Ignore AUD (type 9) and SEI (type 6).
- SPS (7) / PPS (8) → `ingestParamSetNal` → store in cache; fire `codecParamsReady` once both are present.
- VCL types 1 (P) and 5 (IDR):
  - For IDR: enforce `nal.length ≥ minIdrBytes(state)` (8192 default, 2048 for the very first IDR) to drop truncated keyframes.
  - For IDR: require `canEmitIdr(state)` (SPS+PPS in cache and confirmed).
  - If the new NAL is the start of a new AU (`first_mb_in_slice == 0`) and `auNals` is non-empty → `flushAccessUnit`.
- `drainAnnexBRemainder` is called periodically (every 100 ms) and on each chunk to flush a trailing IDR that has no following start code yet, **but only if** ≥ `STREAM_DRAIN_IDLE_MS` (default 400 ms) elapsed and the NAL is ≥ `minIdrBytes`.

### 5.4 IDR-only access units (CRITICAL)

`flushAccessUnit` builds an RTP frame from the queued NALs with this rule:

> **Keyframes are emitted as IDR-only access units. SPS/PPS are never bundled into a keyframe AU. STAP-A and IDR must never share a single RTP timestamp.**

If — through any code path — the first packet of a keyframe AU has its first byte's NAL type equal to 24 (STAP-A), the AU is **rejected**; the keyframe is dropped and `stats.keyframeContainedStap++`. The receiver gets STAP-A only via the explicit bootstrap path (`_flushParamSetsAndOpenGate`) or via the optional periodic refresh (`_refreshParamSets`).

### 5.5 RFC 6184 packetization

`H264RtpPacketizer`:

| NAL size relative to MTU | Packetization | Payload header |
|--------------------------|---------------|----------------|
| ≤ 1200 bytes | Single NAL Unit Packet | `[NALU header][rest of NAL]` |
| > 1200 bytes | FU-A fragments | `[FU indicator (28 \| NRI)][FU header (S/E + type)][slice]` |
| Multiple small NALs (only used for SPS+PPS) | STAP-A aggregate | `[24 \| NRI][len][NAL1][len][NAL2]...` |

- `payloadType = 97`, `clockRate = 90000`.
- `sequenceNumber` is a uint16 counter, starts at a random value; wraps at `0xFFFF`.
- `timestamp` is uint32, 90 kHz. New AU → `timestamp += round(90000 / fps)`. Bootstrap STAP-A consumes one timestamp slot, then `nextRtpTimestamp` is **incremented before** any VCL frame.
- `marker` bit (M) is set **only on the last RTP packet of an access unit** (last fragment of last NAL).
- `ssrc` is randomised per session at packetizer construction; werift's `sender.ssrc` is synced after SDP negotiation (`_syncNegotiatedCodec`).

### 5.6 Param-set bootstrap (server)

When `gate.sdpLocalReady && sdpRemoteReady && dtlsReady && codecParamsReady` all become true:

```
1. STAP-A = packetizeStapA([SPS, PPS], state.nextRtpTimestamp, marker=true)
2. peerConnectionManager.sendFrame(sessionId, [STAP-A])
3. state.paramSetsRtpSent = true
4. gate.paramSetsFlushed = true (markFlag)
5. state.nextRtpTimestamp += round(90000 / fps)     ← MANDATORY
6. setTimeout(_openGateForVcl, STREAM_DECODER_WARMUP_MS)
7. Pacer disabled, emitRtp = false while timer is pending
```

Optional resilience: if `STREAM_PARAM_REFRESH_MS > 0`, every N ms re-emit STAP-A on its own timestamp (no VCL). Useful for late-joining decoders.

### 5.7 Receiver (desktop) feeding rules

For each `OnVideoFrameReceived` payload:

1. Skip non-H.264 formats and zero-length payloads.
2. `LogPayloadShape` for first 3 frames (diagnostic only).
3. `feeds = ExpandPayloadForDecoder(payload)`.
4. For each feed:
   - `UpdateParamSetFlags(feed)` — refresh cache.
   - `if (!CanFeedPayload(feed)) continue;` — drop IDR/P that arrives before any SPS/PPS was seen (rare; only possible if STAP-A bootstrap was lost).
   - `FFmpegVideoEndPoint.GotVideoFrame(remoteEP, ts, feed, format)` — synchronous decode call; errors are logged but never thrown.

Frame ordering rule: feeds must be processed **in submission order**; do not parallelise feeding for one payload because IDR depends on the SPS/PPS feed that precedes it.

### 5.8 Frame ordering on the wire

The combined invariants give a strict ordering on the RTP wire:

```
... SPS,PPS (STAP-A, ts=T)
... (warm-up; no RTP for ~500 ms)
... IDR (FU-A, ts=T+tsStep, marker on last fragment)
... P    (single NAL or FU-A, ts=T+2·tsStep)
... P    ...
... IDR  (FU-A on its own timestamp; may trigger scene_cut WS message)
... P    ...
```

A receiver that joins mid-stream **must** wait for either a STAP-A refresh (if enabled) or a screenrecord segment restart before it can decode. The desktop client does not request such recovery; it relies on the strict startup invariant.

---

## 6. Key System Components (detailed contracts)

### 6.1 `MediaStartupGate`

Pure boolean-flag state machine. Logging is the only side-effect. Public API:

```js
createMediaStartupGate(sessionId)
markFlag(gate, flag, value, reason)
tryOpen(gate, reason)        // returns true iff this call opened the gate
resetCodecPhase(gate, reason)// segment restart: keep sdp/dtls, drop codec/decoder phase
snapshot(gate)
```

Each call to `markFlag` that actually changes a flag emits one log line:

```
[MEDIA_GATE][INFO] Startup state transition { sessionId, from, to, reason }
```

### 6.2 `paramSetCache`

State shape attached to the H.264 processor `state`:

```js
{ sps: Buffer|null, pps: Buffer|null,
  receivedSps, receivedPps, codecParamsConfirmed }
```

**Critical:** every accessor (`storeParamSetNal`, `hasSpsAndPps`, `canEmitIdr`, `getParamSetNals`, `resetForStreamRestart`) **must** call `ensureParamSetState(state)` first. This idempotent initializer prevents `TypeError: Cannot read properties of undefined` when the state object is fresh.

`canEmitIdr(state)` returns true iff:
- `state.sps` and `state.pps` are non-empty Buffers, AND
- `state.codecParamsConfirmed === true` (set by `confirmCodecParams` after both arrive).

### 6.3 `streamProcessor`

Public API: `createStreamProcessorState`, `processH264Chunk`, `tickAnnexBDrain`, `enableRtpEmit`, `flushPendingRtpFrames`, plus re-exports.

Frame shape emitted on the `EventEmitter`:

```js
{
  packets: Buffer[],           // RTP packets, already RFC-6184 encoded
  timestamp: number,           // RTP timestamp shared by all packets
  isKeyframe: boolean,         // true iff this AU contains an IDR (type 5)
  hasSpsPps: false,            // ALWAYS false for VCL frames (SPS/PPS go via STAP-A)
  isParamSetsOnly: false,      // true ONLY for STAP-A bootstrap (separate event)
  size: number,                // bytes of VCL NALs in this AU
  frameNumber: number          // monotonic per session
}
```

Events:

| Event | When | Payload |
|-------|------|---------|
| `codecParamsReady` | First time both SPS and PPS are cached | `{ spsBytes, ppsBytes }` |
| `paramSets` | STAP-A bootstrap ready (emitter mode) | frame with `isParamSetsOnly:true` |
| `frame` | Any AU emitted | frame |
| `keyframe` | AU contains IDR | frame |
| `sceneCut` | Large IDR mid-stream (after first frame) | frame |
| `firstFrame` | `state.framesOut === 1` | — |

### 6.4 `H264RtpPacketizer`

Constructor: `new H264RtpPacketizer({ ssrc?, payloadType?=97, sequenceNumber? })`.
`configure({ payloadType, ssrc })` is called after SDP negotiation to sync with werift.

Methods:
- `packetize(nal, timestamp, isLastNalOfFrame)` → `Buffer[]` (single NAL or FU-A series).
- `packetizeStapA(nals, timestamp, marker=true)` → `Buffer[]` (one packet, or empty if combined size exceeds MTU — only used for SPS+PPS which always fit).
- `packetizeAccessUnit(nals, timestamp)` → STAP-A if it all fits, otherwise sequence of single NAL + FU-A packets.

MTU constant: `MAX_PAYLOAD = 1200` (conservative IPv4 MTU minus RTP/UDP/IP overhead).

### 6.5 Desktop `WebRTCClient`

Public surface:

```cs
event Action<StreamStatus>?         OnStreamStatusChanged;
event Action<string>?               OnIceCandidateGenerated;
event Action<string>?               OnAnswerCreated;
Action<RawImage>?                   OnDecodedRawFrame { get; set; }
Action?                             OnSceneCut { get; set; }
event Action<string>?               OnLog;
event Action<string>?               OnError;

Task<bool>  InitializePeerAsync(string sessionId);
Task        HandleOfferAsync(string sdpOffer);
Task        HandleAnswerAsync(string sdpAnswer);   // not used in this topology (server sends offer)
Task        HandleIceCandidateAsync(string candidateJson);
Task<bool>  PrepareStreamAsync(string sessionId);
void        OnStreamStarted();
void        NotifySceneCut();
void        StopStream();
void        SetSignalingRelay(bool enabled);       // queue local ICE until stream_started lands
```

`SetSignalingRelay(false)` queues every local ICE candidate produced by SIPSorcery until the app has sent `start_stream` and received `stream_started` (otherwise candidates arrive at the server before the peer exists).

### 6.6 Desktop `VideoRenderPipeline`

- `LatestFrameSlot` is mutex-protected, holds at most one `VideoFrameInfo`; on overwrite, `Release()`s the old frame and increments `_replaced` counter (exposed as `SkippedBeforeRender`).
- `WorkerLoop` runs on `ThreadPriority.AboveNormal`, sleeps on `_frameSignal` (`AutoResetEvent`). On wake, drains the slot to the latest frame, converts BGR/RGB/BGRA → BGRA into `_back`, swaps to `_front` under `_swapLock`, and posts `RequestUiPresent` to the Avalonia UI thread at `DispatcherPriority.Render`.
- `PresentLatest` (UI thread) locks the `WriteableBitmap`, blits `_front` into it row-by-row at the bitmap's stride, and calls `_target.UpdateFrame(_bitmap, inPlaceUpdate:true)` followed by `StreamWindow.InvalidateVideoFrame()` so Avalonia repaints the same bitmap.

### 6.7 ICE handling

| Stage | Responsibility |
|-------|----------------|
| Local ICE on server | werift fires `peer.onIceCandidate.subscribe`; if `session.send` is connected, sends `{type:"ice_candidate", data:{candidate:cand.toJSON()}}`. |
| Local ICE on desktop | SIPSorcery fires `peer.onicecandidate += handler`; emit `{candidate, sdpMid, sdpMLineIndex}` JSON, gated by `_signalingRelayEnabled`. |
| Remote ICE on either side | If `remoteDescription` is set, `addIceCandidate(normalized)`. Otherwise, push to `pendingCandidates` and replay after `setRemoteDescription`. |
| Normalisation | Server prepends `candidate:` if missing; desktop tolerates either form. |
| STUN servers | `stun.l.google.com:19302`, `stun1.l.google.com:19302` (and `stun2` on desktop). |
| TURN | Not required for LAN / loopback. Add per-deployment if needed. |

### 6.8 DTLS / RTP readiness

Server-side `isMediaReady(sessionId)` is true iff:
- `pc.iceConnectionState ∈ {connected, completed}`, AND
- `videoSender.dtlsTransport.state === 'connected'`, AND
- `videoSender.codec != null` (H.264 codec was synced).

`waitForMediaReady(sessionId, timeoutMs)` polls every 50 ms up to `timeoutMs`. `_sendBootstrapRtp` and `_sendRtp` both verify `isMediaReady` before calling werift `sendRtp`.

---

## 7. Known Engineering Constraints

These are **hard** constraints. Violating any one of them reproduces a known production bug.

| # | Constraint | Failure mode if violated |
|---|------------|---------------------------|
| 1 | Server must not emit any VCL RTP before SPS+PPS were transmitted as a standalone STAP-A on its own timestamp. | FFmpeg logs `non-existing PPS 0 referenced` and `no frame!`. |
| 2 | STAP-A and IDR must never share an RTP timestamp. | Receiver depacketizer may collapse them into one "encoded frame" and either skip the SPS/PPS or hand FFmpeg a mixed payload that triggers `no frame!`. |
| 3 | Decoder warm-up window (default 500 ms, range 100–2000 ms) must elapse between STAP-A emission and the first IDR. | First-frame corruption / decoder rejecting the IDR slice header because the SPS hasn't propagated yet. |
| 4 | Receiver must build clean Annex-B for FFmpeg — never feed raw STAP-A (NAL type 24) to FFmpeg. | FFmpeg cannot parse NAL type 24 as a picture; logs `no frame!` and never emits a decoded sample. |
| 5 | Receiver must re-inject cached SPS+PPS in front of every IDR feed (belt-and-braces). | Any single packet drop of the STAP-A bootstrap means the decoder is permanently misconfigured until the next segment restart. |
| 6 | `VideoFrameInfo.FromRawImage` must **copy** SIPSorcery's buffer. | Multiple overlapping ghost copies of the UI on screen because the renderer reads pixels while FFmpeg overwrites the same `AVFrame` buffer for the next decoded picture. |
| 7 | `paramSetCache` must initialize its state via `ensureParamSetState` before any read. | Server crash: `TypeError: Cannot read properties of undefined (reading 'receivedSps')`. |
| 8 | `screenrecord` segment restart (every `SCREENRECORD_TIME_LIMIT` seconds, default 180) must reset the codec phase of the gate and re-emit SPS/PPS. | Decoder freezes mid-stream when the new segment starts because the old SPS no longer matches the new IDR. |
| 9 | Pacer must drop frames (latest wins) under back-pressure rather than queueing. | Latency grows unbounded; eventually OOM. |
| 10 | Frame reassembly must be atomic per RTP timestamp. | Partial frames produce torn pictures or decoder slice errors. |
| 11 | `scene_cut` WS message must be ignored on the client until the **first** decoded frame has been published. | Bootstrap IDR is discarded by a decoder reset triggered before it could render. |
| 12 | Outbound local ICE from the desktop must be queued until `stream_started` arrives. | Server applies ICE candidates to a peer that doesn't exist yet → silent failure, no video. |
| 13 | All async tasks in startup paths must have try/catch and never throw unhandled. | Unhandled promise rejections can take down the Node process under load. |

---

## 8. Control System

### 8.1 Protocol

The desktop sends a single message type for all control events:

```json
{
  "type": "control",
  "event": {
    "action": "tap" | "swipe" | "key" | "text",
    "...": "..."
  }
}
```

The server answers with `control_result` (success / error). Latency budget: ≤ 80 ms LAN round-trip (typed events may batch on UI side).

### 8.2 Action payloads

```json
// Tap — normalized [0..1] coordinates relative to the video surface
{ "action": "tap", "x": 0.5, "y": 0.42 }

// Swipe — normalized start, end, duration in milliseconds (default 150 ms)
{ "action": "swipe", "x1": 0.1, "y1": 0.8, "x2": 0.9, "y2": 0.8, "durationMs": 200 }

// Key — Android keycode string (KEYCODE_BACK, KEYCODE_HOME, KEYCODE_ENTER, ...)
{ "action": "key", "keyCode": "KEYCODE_BACK" }

// Text — UTF-8 string; server escapes for `adb shell input text`
{ "action": "text", "text": "hello world" }
```

### 8.3 Server-side execution

`ControlRouter.handleControl(sessionId, event)`:
1. Look up the active `ScreenrecordCapture` registered for the session. Reject with `"No device capture for session"` if absent.
2. `capture.injectInput(event)` denormalizes the coordinates against `queryDisplaySize(deviceId)` (cached after `capture.start()`).
3. Executes one of:
   - `adb -s <id> shell input tap <px> <py>`
   - `adb -s <id> shell input swipe <x1> <y1> <x2> <y2> <durationMs>`
   - `adb -s <id> shell input keyevent <keyCode>`
   - `adb -s <id> shell input text <escaped>`
4. Returns `{success: true}` or `{success: false, error}`.

### 8.4 Desktop-side mapping

`StreamWindow` registers `PointerPressed`, `PointerReleased`, `KeyDown` handlers.

- `OnPointerPressed`: stash `(nx, ny) = clamp01(pos.X / size.Width, pos.Y / size.Height)`.
- `OnPointerReleased`:
  - `dist = sqrt(dx² + dy²)` over the press-release delta.
  - `dist > 0.02` → `SendRemoteSwipeAsync(startX, startY, nx, ny)`.
  - else → `SendRemoteTapAsync(nx, ny)`.
- `OnKeyDown`: map `Key.Back/Escape → KEYCODE_BACK`, `Key.Home → KEYCODE_HOME`, `Key.Enter → KEYCODE_ENTER` and send.

Coordinates are always **normalized [0..1]** end-to-end. The server is the single source of truth on physical resolution.

---

## 9. UI / UX Design Spec

The application ships two windows:

### 9.1 Main Window — "Android Emulator Control Panel"

Single column, 4 row layout, padding 24:

```
┌──────────────────────────────────────────────────────────────────┐
│ Android Emulator Control Panel                  (28 pt, bold)    │
│ Connect to WebSocket server, create a session, then start stream │
├──────────────────────────────────────────────────────────────────┤
│ WebSocket Server URL                                              │
│ ┌─────────────────────────┐ [Connect] [Disconnect] [● Status]    │
│ │ ws://localhost:8080     │                                       │
│ └─────────────────────────┘                                       │
├──────────────────────────────────────────────────────────────────┤
│ Logs                                                  [Clear]     │
│ ┌────────────────────────────────────────────────────────────┐    │
│ │ [12:29:53.916] [WebRTC] Connection: connected              │    │
│ │ [12:29:54.817] [WebRTC] First encoded frame ...            │    │
│ │ (monospace, scrollable, auto-scroll on append)             │    │
│ └────────────────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────────┤
│ Device                                                            │
│ ┌────────────────┐ [Status] [Refresh] [Create Session] [Destroy] │
│ │ Pixel_5_API_30 ▼│                                              │
│ └────────────────┘                                                │
│ Stream                                                            │
│           [● Streaming] [Start Stream] [Stop Stream]              │
└──────────────────────────────────────────────────────────────────┘
```

### 9.2 Stream Window — "Live Stream"

A second window opens automatically when `start_stream` succeeds:

```
┌──────────────────────────────────────────────────────────────────┐
│ Session: 4ceaaf0d... | Streaming   Decode 20 fps · Render 20 fps │
│                                          · Dropped 0  [Stop]      │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│                                                                   │
│                                                                   │
│                  ┌──────────────────────────┐                     │
│                  │                          │                     │
│                  │   <Avalonia Image,       │                     │
│                  │    Stretch="Uniform",    │                     │
│                  │    interpolation=None>   │                     │
│                  │                          │                     │
│                  │   (decoded device        │                     │
│                  │    framebuffer)          │                     │
│                  │                          │                     │
│                  └──────────────────────────┘                     │
│                                                                   │
│  Placeholder when HasVideoFrame == false:                         │
│      "Waiting for video..."                                       │
│      "Stream is negotiating or encoding"                          │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

Behaviour:
- Captures pointer + key events; never propagates them to the OS so global shortcuts don't fire.
- Stretch mode `Uniform` preserves aspect ratio; black letterboxing around the picture.
- `RenderOptions.BitmapInterpolationMode="None"` for crisp pixel-mapped device pixels.
- The metrics text updates once per second via a `DispatcherTimer`.

### 9.3 Controls reference

| Control | Mode | Effect |
|---------|------|--------|
| Pointer click (no drag) | Tap | Single normalized tap |
| Pointer drag > 2% of frame | Swipe | Sends swipe with `durationMs` based on press time |
| Backspace / Escape | Key | `KEYCODE_BACK` |
| Home (on hardware kbds with that key) | Key | `KEYCODE_HOME` |
| Enter | Key | `KEYCODE_ENTER` |
| Right-click | (reserved for future context menu) | — |

### 9.4 Connection status indicators

| Color (hex) | Meaning |
|-------------|---------|
| `#4CAF50` (green) | Connected / Streaming |
| `#FFC107` (amber) | Connecting / Negotiating |
| `#9C27B0` (purple) | Stream starting |
| `#6C757D` (grey) | Idle / Disconnected |
| `#DC3545` (red) | Error |

---

## 10. Theme / Colors

Dark mode only. Use exact hex codes below.

| Token | Color | Usage |
|-------|-------|-------|
| `--bg-base` | `#1E1E1E` | Main window background |
| `--bg-surface` | `#2D2D2D` | Card / panel background |
| `--bg-elevated` | `#363636` | Panel headers, log header bar |
| `--bg-input` | `#3C3C3C` | TextBox / ComboBox / status pill background |
| `--bg-input-disabled` | `#4A4A4A` | Disabled controls |
| `--border-input` | `#555555` | TextBox borders |
| `--fg-primary` | `#FFFFFF` | Headings, primary text |
| `--fg-secondary` | `#E0E0E0` | Log body text |
| `--fg-muted` | `#AAAAAA` | Field labels |
| `--fg-disabled` | `#888888` | Subtitle text |
| `--fg-very-muted` | `#666666` / `#444444` | Placeholder text in StreamWindow |
| `--accent-primary` | `#0078D4` (electric blue) | Connect / Create Session button |
| `--accent-stream` | `#9C27B0` (purple) | Start Stream button |
| `--accent-danger` | `#DC3545` (red) | Destroy Session button |
| `--accent-stop` | `#FF5722` (orange-red) | Stop Stream button |
| `--accent-neutral` | `#6C757D` (slate) | Refresh / Disconnect button |
| `--status-ok` | `#4CAF50` (green) | Success indicators |
| `--status-warn` | `#FFC107` (amber) | Negotiating |
| `--status-error` | `#DC3545` (red) | Error |
| `--metrics-ok` | `#88FF88` (mint) | StreamWindow metrics text |
| `--video-bg` | `#000000` | StreamWindow background (true black) |
| `--video-header-bg` | `#1A1A1A` | StreamWindow header |

Corner radii: 12 px for panels, 8 px for inputs, 6 px for compact buttons.

Typography:
- **UI labels & buttons**: Inter (`Avalonia.Fonts.Inter` package), 12–28 pt, weights 400/600/700.
- **Logs**: Monospace stack `Consolas, Monaco, 'Courier New', monospace`, 13 pt.
- **Metrics overlay**: same monospace stack, 11 pt, color `#88FF88`.

Spacing: prefer 8 / 12 / 16 / 20 / 24 px multiples. Buttons are 16–20 px horizontal padding, 8–10 px vertical.

---

## 11. Networking & Protocols

### 11.1 WebSocket envelope

Every message is a JSON object containing `type`. Server responses additionally carry `success`, `data` (or `error`), and `timestamp`. Clients may attach `requestId` for correlation; the server echoes it back.

### 11.2 WebSocket message reference (minimum viable set)

| Direction | type | Body | Response |
|-----------|------|------|----------|
| C→S | `create_session` | `{device, options?}` | `session_created{device_id, ...}` |
| C→S | `destroy_session` | `{kill_emulator?}` | `session_destroyed` |
| C→S | `get_devices` | `{}` | `devices_list{devices:[...]}` |
| C→S | `start_stream` | `{options?}` | `stream_started{webrtc_offer:{type,sdp}}` |
| C→S | `webrtc_answer` | `{sdp}` or `{answer:{type,sdp}}` | `webrtc_answer_received` |
| C→S | `ice_candidate` | `{candidate:{candidate,sdpMid,sdpMLineIndex}}` | `ice_candidate_received` |
| C→S | `control` | `{event:{action,...}}` | `control_result` |
| C→S | `stop_stream` | `{}` | `stream_stopped` |
| C→S | `stream_status` | `{}` | `stream_status` |
| C→S | `ping` | `{}` | `pong{timestamp}` |
| S→C | `ice_candidate` | `{data:{candidate:...}}` | — |
| S→C | `scene_cut` | `{session_id}` | — |
| S→C | `stream_error` | `{error}` | — |
| S→C | `session_timeout` | `{message}` | — |
| S→C | `peer_connected` | `{data:{session_id, peer_id}}` | — |

Message handling on the server is **strictly serialised per socket** (one `Promise` chain). This avoids ICE/answer reordering races.

### 11.3 WebRTC SDP / ICE flow

```
Server (sendonly) ──── createOffer() ──── stream_started{webrtc_offer} ─── Desktop
                                                                              │
                                                  setRemoteDescription(offer) │
                                                  createAnswer()              │
                                                  setLocalDescription(answer) │
Server ◄──── webrtc_answer{sdp} ──────────────────────────────────────────────┘
       setRemoteDescription(answer) → gate.sdpRemoteReady=true

Trickle ICE:
  Server peer.onIceCandidate ──── ice_candidate ──► Desktop peer.addIceCandidate
  Desktop peer.onicecandidate ──── ice_candidate ──► Server peer.addIceCandidate
  Both sides queue candidates received before remoteDescription is set
  and replay them after.
```

Both SDPs must contain exactly **one** H.264 rtpmap (`H264/90000`) with `packetization-mode=1` and `profile-level-id=42e01f`. The server actively strips any VP8 lines before sending the offer (`ensureH264OnlySdp`).

### 11.4 RTP transport

- DTLS-SRTP over UDP, negotiated via SDP. werift handles encryption transparently; the application code deals only in plaintext RTP buffers (`RtpPacket` instances).
- Single video transceiver (sendonly server / recvonly desktop).
- RTP packetization is **always** RFC 6184 (Annex-B H.264, packetization-mode 1).
- No RTX, no FEC. Loss recovery for SPS/PPS is via the optional `STREAM_PARAM_REFRESH_MS` resilience timer or — for VCL — the periodic IDR generated by `screenrecord` (typically every ~2 s).

### 11.5 Latency budget (default settings)

| Stage | Typical | Notes |
|-------|---------|-------|
| `adb screenrecord` capture latency | 30–60 ms | Android MediaCodec + USB / ADB pipe |
| Server H.264 parsing & packetization | < 2 ms | Pure JS, MTU-friendly |
| Network (loopback / LAN) | 1–15 ms | RTT/2 plus jitter |
| SIPSorcery depacketization | < 5 ms | |
| FFmpeg decode | 5–20 ms | Software decode at 480×854 |
| BGR→BGRA convert + UI present | 3–8 ms | One row-wise copy + Avalonia blit |
| **End-to-end (steady state)** | **~50–110 ms** | LAN |

---

## 12. Configuration

All variables are read at process start. Defaults are tuned for 480 × 854 @ 20 fps.

### 12.1 Server (Node.js)

| Variable | Default | Range / unit | Effect |
|----------|---------|--------------|--------|
| `PORT` | `8080` | TCP port | WebSocket listen port |
| `HOST` | `0.0.0.0` | hostname | Bind address |
| `ADB_PATH` | `adb` | path | ADB executable |
| `EMULATOR_PATH` | `emulator` | path | Android emulator binary |
| `FFMPEG_PATH` | `ffmpeg` | path | Reserved for future server-side transcode |
| `STREAM_WIDTH` × `STREAM_HEIGHT` | `480 × 854` | px | `screenrecord --size` |
| `STREAM_FPS` | `20` | fps | RTP timestamp step + pacer rate |
| `STREAM_RECORD_BITRATE` | `2000000` | bps | `screenrecord --bit-rate` |
| `SCREENRECORD_TIME_LIMIT` | `180` | seconds | `--time-limit` (auto-restart) |
| `STREAM_KEYFRAMES_ONLY` | `false` | bool | If true, drop P-frames (low FPS, no ghosting) |
| `STREAM_MIN_IDR_BYTES` | `8192` | bytes | Minimum size for subsequent IDRs |
| `STREAM_FIRST_IDR_MIN_BYTES` | `2048` | bytes | Looser bar for the very first IDR |
| `STREAM_DRAIN_IDLE_MS` | `400` | ms | Idle gap before flushing trailing IDR with no following start code |
| `STREAM_IDR_DEDUP_MS` | `2500` | ms | Suppress duplicate small IDRs |
| `STREAM_CODEC_WAIT_MS` | `30000` | ms | Max wait for SPS/PPS from capture |
| `STREAM_DECODER_WARMUP_MS` | `500` | ms (100–2000) | Warm-up between STAP-A and first IDR |
| `STREAM_PARAM_REFRESH_MS` | `0` | ms | If > 0, re-emit STAP-A every N ms |
| `KILL_EMULATOR_ON_DISCONNECT` | `true` | bool | Stop owned emulators on socket close |
| `HEARTBEAT_INTERVAL` | `30000` | ms | WS ping cadence |
| `SESSION_CLEANUP_INTERVAL` | `300000` | ms | Stale-session sweep cadence |
| `DEBUG` | `false` | bool | Enable `[*][DEBUG]` log lines |

### 12.2 Desktop

| Variable | Default | Effect |
|----------|---------|--------|
| `FFMPEG_LIB_PATH` | auto-detect | Directory containing `libavutil.dylib` / `libavcodec.dylib` etc. Auto-search order: `$FFMPEG_LIB_PATH`, `/opt/homebrew/lib`, `/opt/homebrew/opt/ffmpeg/lib`, `/usr/local/lib`, `/usr/local/opt/ffmpeg/lib`. |

---

## 13. Repository Layout (target)

```
.
├── BLUEPRINT.md                       ← this file
├── README.md
│
├── websocket_nodejs/
│   └── adb-emulator-server/           ← Node.js gateway
│       ├── package.json
│       ├── server.js
│       ├── sessionManager.js
│       ├── emulator.js, emulatorManager.js, adb.js
│       ├── webrtcSignaling.js
│       ├── control/
│       │   ├── ControlRouter.js
│       │   └── input.js
│       ├── lib/
│       │   ├── config.js
│       │   └── logger.js
│       └── stream/
│           ├── index.js
│           ├── StreamManager.js
│           ├── MediaStartupGate.js
│           ├── FramePacer.js
│           ├── capture/
│           │   ├── factory.js
│           │   └── ScreenrecordCapture.js
│           ├── webrtc/
│           │   └── PeerConnection.js
│           └── media/h264/
│               ├── index.js
│               ├── h264AnnexBParser.js
│               ├── h264AvccParser.js
│               ├── h264SliceHeader.js
│               ├── appendBuffer.js
│               ├── paramSetCache.js
│               ├── streamProcessor.js
│               └── h264RtpPacketizer.js
│
└── EmulatorDesktopApp/                ← .NET 10 Avalonia client
    ├── EmulatorDesktopApp.csproj
    ├── Program.cs, App.axaml(.cs)
    ├── MainWindow.axaml(.cs)
    ├── StreamWindow.axaml(.cs)
    ├── Services/
    │   ├── WebSocketService.cs
    │   ├── ServerMessageJson.cs
    │   ├── RemoteControlService.cs
    │   ├── WebRTCClient.cs
    │   ├── VideoFrameConverter.cs
    │   ├── VideoFrameInfo.cs
    │   └── StreamMetrics.cs
    ├── Streaming/
    │   ├── MirrorSession.cs
    │   ├── VideoRenderPipeline.cs
    │   └── LatestFrameSlot.cs
    └── ViewModels/
        ├── MainWindowViewModel.cs
        ├── StreamWindowViewModel.cs
        └── Commands/RelayCommands.cs
```

### 13.1 NuGet packages (desktop)

```xml
<PackageReference Include="Avalonia"                  Version="12.0.3" />
<PackageReference Include="Avalonia.Desktop"          Version="12.0.3" />
<PackageReference Include="Avalonia.Themes.Fluent"    Version="12.0.3" />
<PackageReference Include="Avalonia.Fonts.Inter"      Version="12.0.3" />
<PackageReference Include="SIPSorcery"                Version="10.0.7" />
<PackageReference Include="SIPSorceryMedia.Abstractions" Version="10.0.7" />
<PackageReference Include="SIPSorceryMedia.FFmpeg"    Version="10.0.7" />
<PackageReference Include="Microsoft.Extensions.Logging"          Version="10.0.7" />
<PackageReference Include="Microsoft.Extensions.Logging.Abstractions" Version="10.0.7" />
```

`AllowUnsafeBlocks=true` and `AvaloniaUseCompiledBindingsByDefault=true` in the `.csproj`.

### 13.2 npm dependencies (server)

```json
{
  "dependencies": {
    "ws": "^8.x",
    "werift": "^0.18.x",
    "uuid": "^9.x"
  }
}
```

`werift` is the only WebRTC implementation; no native modules required.

### 13.3 System prerequisites

| Platform | Requirement |
|----------|-------------|
| Server host | Node.js ≥ 18; Android SDK with `adb` and `emulator` in `PATH` |
| Desktop host | .NET SDK 10; FFmpeg shared libraries (`libavutil`, `libavcodec`, `libavformat`, `libavfilter`, `libavdevice`, `libswscale`, `libswresample`) — install via Homebrew (`brew install ffmpeg`) on macOS, FFmpeg release zip on Windows, distro packages on Linux |
| Network | UDP egress for WebRTC media; TCP for WebSocket signaling |

---

## 14. Acceptance Criteria (rebuild verification)

A correct re-implementation must satisfy **all** of the following:

### 14.1 Functional

1. After `start_stream`, the client receives `webrtc_offer` containing exactly one H.264 rtpmap with `packetization-mode=1;profile-level-id=42e01f` and zero VP8 rtpmaps.
2. The first decoded frame appears on screen within 1500 ms of the client sending `webrtc_answer`.
3. The first decoded frame is **visually clean** — no overlapping copies, no green/grey artefacts, no decoder warnings.
4. Tap, swipe, key, and text events produce the expected effect on the device within 80 ms (LAN).
5. Closing the WebSocket cleanly stops `adb screenrecord`, closes the peer connection, and (if owned) shuts down the emulator.

### 14.2 Logging — first 2 s of a session must contain in order

```
[STREAM_MGR][INFO] Capture parse-only until startup gate opens
[MEDIA_GATE][INFO] Startup state transition  from=wait_sdp_local      to=wait_sdp_remote
[MEDIA_GATE][INFO] Startup state transition  from=wait_sdp_remote     to=wait_dtls
[MEDIA_GATE][INFO] Startup state transition  from=wait_dtls           to=wait_codec
[STREAM_MGR][INFO] Codec params ready (SPS+PPS in pipeline)
[MEDIA_GATE][INFO] Startup state transition  from=wait_codec          to=send_sps_pps
[STREAM_MGR][INFO] STAP-A bootstrap flushed (SPS + PPS standalone)
[MEDIA_GATE][INFO] Startup state transition  from=send_sps_pps        to=wait_decoder
[STREAM_MGR][INFO] Decoder warm-up started
[STREAM_MGR][INFO] Decoder warm-up elapsed — opening gate for VCL
[MEDIA_GATE][INFO] Media startup gate OPEN — VCL RTP video allowed
[STREAM_MGR][INFO] First IDR access unit emitted
[PEER][INFO]       First video frame sent via WebRTC
```

### 14.3 Failure-mode tests

| Test | Expected behaviour |
|------|---------------------|
| Restart `adb screenrecord` (segment timeout) | `Capture segment restart — awaiting SPS → PPS → STAP → IDR` is logged, gate transitions back through `WAIT_CODEC`/`SEND_SPS_PPS`/`WAIT_DECODER`, and streaming resumes within ~1 s. No corruption. |
| Drop the STAP-A packet (simulate with `STREAM_PARAM_REFRESH_MS=1500`) | After at most one refresh interval, decoder recovers. |
| Disconnect mid-stream | Server logs `Stream stopped`, kills `adb screenrecord`, closes peer, optionally stops emulator. |
| Client sends ICE before `start_stream` | Server replies `No active stream. Call start_stream and wait for stream_started before sending ICE.` — never crashes. |
| Client sends `webrtc_answer` with no SDP | Server replies `sdp is required` — never crashes. |
| `paramSetCache` accessed on a fresh state object | `ensureParamSetState` initialises lazily; no `TypeError`. |
| Hold a `VideoFrameInfo` across decode boundary | Pixels remain stable (independent ArrayPool buffer); no ghosting. |

---

## 15. Build & Run

### 15.1 Server

```bash
cd websocket_nodejs/adb-emulator-server
npm install
PORT=8080 npm start
# logs:
# [SERVER][INFO] Server started   { host: '0.0.0.0', port: 8080 }
# [SERVER][INFO] Stream — server WebRTC (werift) + adb screenrecord
```

### 15.2 Desktop

```bash
cd EmulatorDesktopApp
dotnet run
# alternative (macOS, custom FFmpeg path):
FFMPEG_LIB_PATH=/opt/homebrew/opt/ffmpeg/lib dotnet run
```

### 15.3 Smoke test

1. Start the server.
2. Start an emulator (`emulator -avd Pixel_5_API_30`) and confirm `adb devices` shows `online`.
3. Launch the desktop app, enter `ws://localhost:8080`, click **Connect**.
4. Select the device in the combo box, click **Create Session**, then **Start Stream**.
5. The Live Stream window opens; first frame appears within ~1 s; tap/swipe on the video controls the device.

---

## 16. Glossary

| Term | Definition |
|------|------------|
| AU (Access Unit) | A set of H.264 NAL units that produce exactly one decoded picture. |
| NAL (Network Abstraction Layer) unit | Atomic H.264 syntactic element (one byte header + payload). Types used here: SPS (7), PPS (8), IDR slice (5), non-IDR slice (1), STAP-A (24), FU-A (28). |
| SPS | Sequence Parameter Set — describes resolution, profile, chroma format, etc. Must be in the decoder DPB before any slice can be decoded. |
| PPS | Picture Parameter Set — references an SPS; describes slice grouping, deblocking, etc. |
| IDR | Instantaneous Decoder Refresh — an intra-coded slice that clears the decoder's reference list. Required as the first VCL frame after SPS/PPS. |
| Annex-B | H.264 byte-stream format using `00 00 [00] 01` start codes between NAL units. The format that FFmpeg expects on its input. |
| AVCC | Length-prefixed H.264 format (no start codes); used in MP4 containers. Detected as a fallback. |
| STAP-A | "Single-Time Aggregation Packet A" — RTP payload that aggregates multiple NAL units sharing one RTP timestamp. Used here exclusively to ship SPS+PPS as a pair. |
| FU-A | "Fragmentation Unit A" — splits a large NAL unit (typically an IDR slice) across multiple RTP packets, with start/end markers in the FU header. |
| MediaStartupGate | Server-side state machine ensuring that no VCL RTP leaves the wire until ICE, DTLS, codec params, STAP-A bootstrap, and decoder warm-up are all complete. |
| Pacer | One-slot, latest-wins, fps-paced submitter that drops backlogged frames rather than queueing them. |
| Werift | Pure-TypeScript / JavaScript WebRTC stack used as the server peer. |
| SIPSorcery | .NET WebRTC stack used as the desktop peer; includes a built-in RTP H.264 depacketizer. |
| Scene cut | A large IDR mid-stream signalling a likely full-screen change; the server informs the client to reset its decoder. |
| DPB | Decoded Picture Buffer — the decoder's reference-frame store. |

---

**End of blueprint.** Implementations that satisfy §1–§15 are functionally equivalent regardless of internal layout, but the constraints in §7 are non-negotiable.
