using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Diagnostics;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using SIPSorcery.Net;
using SIPSorceryMedia.Abstractions;
using SIPSorceryMedia.FFmpeg;

namespace EmulatorDesktopApp.Services
{
    /// <summary>
    /// WebRTC client: SIPSorcery depacketizes RTP into complete encoded frames;
    /// FFmpeg decodes to raw pixels for the render pipeline.
    /// </summary>
    public class WebRTCClient : IDisposable
    {
        private static bool _loggingInitialized;
        private static bool _ffmpegInitialized;
        private bool _disposed;
        private RTCPeerConnection? _peerConnection;
        private FFmpegVideoEndPoint? _videoEndPoint;
        private string? _currentSessionId;
        private readonly List<RTCIceCandidateInit> _pendingCandidates = new();
        private bool _hasRemoteDescription;
        private int _encodedFrameCount;
        private int _decodePublished;
        private volatile bool _h264ParamsReady;
        // Strict-gate flag: an accepted IDR must have arrived since stream
        // initialization before P-frames are allowed to reach the decoder.
        // Stability-first contract: this flag is set true on the first
        // accepted IDR and only ever cleared by InitializePeerAsync /
        // ClosePeer. scene_cut does NOT touch it, because closing the gate
        // mid-stream causes the "scene_cut drops" pathology when no fresh
        // IDR follows for many seconds.
        private volatile bool _idrSinceReset;
        // One-shot log latch: the "Codec ready — gate OPEN" line is emitted
        // exactly once per reset (cleared on peer init only).
        private volatile bool _codecReadyLogged;
        private volatile bool _loggedSps;
        private volatile bool _loggedPps;

        /// <summary>
        /// After a scene cut, drop decoded frames until the next IDR picture
        /// is rendered. Prevents stale P-frames already in the FFmpeg pipeline
        /// from being painted on top of the new scene (visible as overlap).
        /// </summary>
        private volatile bool _dropDecodedUntilIdr;
        private volatile bool _acceptNextDecodedFrame;

        /// <summary>
        /// Strict decoder admission flag, as required by the H.264 ingestion
        /// spec: <c>codecReady = SPS_received &amp;&amp; PPS_received &amp;&amp;
        /// IDR_received_after_them</c>. No video payload (IDR or P) is allowed
        /// to reach FFmpeg while this is false.
        /// </summary>
        private bool CodecReady => _h264ParamsReady && _idrSinceReset;
        private int _skippedPreParamFrames;
        private int _acceptedIdrCount;
        // Cached SPS/PPS NAL units (no start codes) for in-band re-injection on every IDR.
        private byte[]? _cachedSpsNal;
        private byte[]? _cachedPpsNal;
        private readonly object _paramSetLock = new();
        private VideoFormat? _activeVideoFormat;
        private CancellationTokenSource? _mediaWatchCts;
        private long _mediaWatchStartedTicks;
        private long _firstFrameTicks;
        private Action<RTCIceCandidate>? _onIceCandidateHandler;
        private volatile bool _signalingRelayEnabled;
        private readonly List<string> _pendingOutboundIce = new();

        private static void EnsureLoggingInitialized()
        {
            if (!_loggingInitialized)
            {
                SIPSorcery.LogFactory.Set(new NullLoggerFactory());
                _loggingInitialized = true;
            }
        }

        private static string? ResolveFfmpegLibPath()
        {
            var fromEnv = Environment.GetEnvironmentVariable("FFMPEG_LIB_PATH");
            if (!string.IsNullOrWhiteSpace(fromEnv) && Directory.Exists(fromEnv))
                return fromEnv;

            string[] candidates =
            {
                "/opt/homebrew/lib",
                "/opt/homebrew/opt/ffmpeg/lib",
                "/usr/local/lib",
                "/usr/local/opt/ffmpeg/lib"
            };

            foreach (var path in candidates)
            {
                if (Directory.Exists(path) && Directory.GetFiles(path, "libavutil*.dylib").Length > 0)
                    return path;
            }

            return null;
        }

        private static void EnsureFfmpegInitialized()
        {
            if (_ffmpegInitialized)
                return;

            EnsureLoggingInitialized();
            var libPath = ResolveFfmpegLibPath();
            if (libPath != null)
                FFmpegInit.Initialise(libPath: libPath);
            else
                FFmpegInit.Initialise();

            _ffmpegInitialized = true;
        }

        public event Action<StreamStatus>? OnStreamStatusChanged;
        public event Action<string>? OnIceCandidateGenerated;
        public event Action<string>? OnAnswerCreated;
        public Action<RawImage>? OnDecodedRawFrame { get; set; }
        public Action? OnSceneCut { get; set; }
        public event Action<string>? OnLog;
        public event Action<string>? OnError;

        public bool IsPeerInitialized => _peerConnection != null;
        public bool IsSignalingRelayEnabled => _signalingRelayEnabled;
        public string? CurrentSessionId => _currentSessionId;
        public RTCPeerConnectionState? ConnectionState => _peerConnection?.connectionState;

        /// <summary>
        /// When false, local ICE is queued until relay is enabled (after stream_started / setLocalDescription).
        /// </summary>
        public void SetSignalingRelay(bool enabled)
        {
            _signalingRelayEnabled = enabled;
            if (!enabled)
            {
                lock (_pendingOutboundIce)
                    _pendingOutboundIce.Clear();
                return;
            }

            List<string> pending;
            lock (_pendingOutboundIce)
            {
                pending = new List<string>(_pendingOutboundIce);
                _pendingOutboundIce.Clear();
            }

            foreach (var json in pending)
                OnIceCandidateGenerated?.Invoke(json);
        }

        public async Task<bool> InitializePeerAsync(string sessionId)
        {
            try
            {
                EnsureLoggingInitialized();
                EnsureFfmpegInitialized();
                var ffmpegLib = ResolveFfmpegLibPath() ?? "(system default)";
                OnLog?.Invoke($"[WebRTC] FFmpeg initialized (lib: {ffmpegLib})");

                if (_peerConnection != null)
                    ClosePeer();

                _currentSessionId = sessionId;
                _hasRemoteDescription = false;
                _pendingCandidates.Clear();
                _encodedFrameCount = 0;
                _h264ParamsReady = false;
                _idrSinceReset = false;
                _codecReadyLogged = false;
                _loggedSps = false;
                _loggedPps = false;
                _dropDecodedUntilIdr = false;
                _acceptNextDecodedFrame = false;
                _skippedPreParamFrames = 0;
                _acceptedIdrCount = 0;
                lock (_paramSetLock)
                {
                    _cachedSpsNal = null;
                    _cachedPpsNal = null;
                }

                var config = new RTCConfiguration
                {
                    iceServers = new List<RTCIceServer>
                    {
                        new() { urls = "stun:stun.l.google.com:19302" },
                        new() { urls = "stun:stun1.l.google.com:19302" },
                        new() { urls = "stun:stun2.l.google.com:19302" }
                    }
                };

                _videoEndPoint = new FFmpegVideoEndPoint();
                _videoEndPoint.OnVideoSinkDecodedSampleFaster += HandleDecodedVideoFrame;

                var sinkFormats = FilterH264Formats(_videoEndPoint.GetVideoSinkFormats());
                if (sinkFormats.Count == 0)
                {
                    OnError?.Invoke("[WebRTC] No H.264 decoder formats available in FFmpeg");
                    return false;
                }

                OnLog?.Invoke($"[WebRTC] Decoder formats: {string.Join(", ", sinkFormats.Select(f => $"{f.FormatName} PT={f.FormatID}"))}");

                _peerConnection = new RTCPeerConnection(config);
                SetupPeerConnectionEvents();

                var videoTrack = new MediaStreamTrack(sinkFormats, MediaStreamStatusEnum.RecvOnly);
                _peerConnection.addTrack(videoTrack);

                _peerConnection.OnVideoFormatsNegotiated += formats =>
                {
                    if (formats == null || formats.Count == 0)
                        return;
                    ApplyDecoderFormat(PickH264Format(formats), "negotiated");
                };

                OnLog?.Invoke("[WebRTC] Peer ready — using SIPSorcery RTP depacketization + FFmpeg decode");
                OnStreamStatusChanged?.Invoke(StreamStatus.Initialized);
                return true;
            }
            catch (Exception ex)
            {
                OnError?.Invoke($"[WebRTC] Failed to initialize peer: {ex.Message}");
                OnStreamStatusChanged?.Invoke(StreamStatus.Error);
                return false;
            }
        }

        private void HandleDecodedVideoFrame(RawImage rawImage)
        {
            if (rawImage == null || rawImage.Width <= 0 || rawImage.Height <= 0)
                return;

            if (_dropDecodedUntilIdr)
            {
                if (!_acceptNextDecodedFrame)
                    return;
                _acceptNextDecodedFrame = false;
                _dropDecodedUntilIdr = false;
            }

            Interlocked.Increment(ref _decodePublished);
            OnDecodedRawFrame?.Invoke(rawImage);
        }

        private void SetupPeerConnectionEvents()
        {
            if (_peerConnection == null)
                return;

            _onIceCandidateHandler = candidate =>
            {
                if (candidate == null || string.IsNullOrEmpty(candidate.candidate))
                    return;

                OnLog?.Invoke($"[WebRTC] Local ICE candidate: {candidate.candidate[..Math.Min(50, candidate.candidate.Length)]}...");
                var candidateJson = JsonSerializer.Serialize(new
                {
                    candidate = candidate.candidate,
                    sdpMid = candidate.sdpMid ?? "0",
                    sdpMLineIndex = (int)candidate.sdpMLineIndex
                });
                EmitOrQueueIceCandidate(candidateJson);
            };
            _peerConnection.onicecandidate += _onIceCandidateHandler;

            _peerConnection.onicegatheringstatechange += state =>
                OnLog?.Invoke($"[WebRTC] ICE gathering: {state}");

            _peerConnection.oniceconnectionstatechange += state =>
            {
                OnLog?.Invoke($"[WebRTC] ICE connection: {state}");
                if (state == RTCIceConnectionState.connected)
                    OnStreamStatusChanged?.Invoke(StreamStatus.Active);
                else if (state == RTCIceConnectionState.failed)
                {
                    OnError?.Invoke("[WebRTC] ICE connection failed");
                    OnStreamStatusChanged?.Invoke(StreamStatus.Error);
                }
            };

            _peerConnection.onconnectionstatechange += state =>
            {
                OnLog?.Invoke($"[WebRTC] Connection: {state}");
                if (state == RTCPeerConnectionState.failed)
                {
                    OnError?.Invoke("[WebRTC] Peer connection failed");
                    OnStreamStatusChanged?.Invoke(StreamStatus.Error);
                }
                else if (state == RTCPeerConnectionState.closed)
                    OnStreamStatusChanged?.Invoke(StreamStatus.Stopped);
            };

            // SIPSorcery reconstructs full encoded frames from RTP (RFC 6184) — no custom FU-A assembly.
            // Direct path (no jitter buffer): every received access unit is
            // immediately admitted through the strict H.264 gate and, if
            // accepted, handed to FFmpeg on the SIPSorcery network thread.
            // Stability-first contract: synchronous, single-thread processing
            // eliminates the buffer-vs-decoder teardown races and the
            // MaxAge-induced silent drops we saw with the jitter buffer.
            _peerConnection.OnVideoFrameReceived += (IPEndPoint remoteEndPoint, uint timestamp, byte[] payload, VideoFormat format) =>
            {
                if (payload == null || payload.Length == 0)
                    return;

                if (!IsH264Format(format))
                    return;

                var endpoint = _videoEndPoint;
                if (endpoint == null)
                    return;

                if (_activeVideoFormat == null || _activeVideoFormat.Value.FormatID != format.FormatID)
                    ApplyDecoderFormat(format, "frame");

                var n = Interlocked.Increment(ref _encodedFrameCount);
                if (n == 1)
                {
                    CancelMediaWatch();
                    _firstFrameTicks = Stopwatch.GetTimestamp();
                    OnLog?.Invoke($"[WebRTC] First encoded frame from SIPSorcery depacketizer ({payload.Length} bytes)");
                }
                else if (n == 5 || n == 30 || n == 60 || n == 120 || n % 300 == 0)
                {
                    OnLog?.Invoke(
                        $"[WebRTC] Encoded #{n} bytes={payload.Length} decoded={_decodePublished} " +
                        $"acceptedIdr={_acceptedIdrCount} droppedPreGate={_skippedPreParamFrames} " +
                        $"sps={_h264ParamsReady} idr={_idrSinceReset} codecReady={CodecReady}");
                }

                LogPayloadShape(payload, n);

                // 1) Cache any SPS/PPS in this payload BEFORE we build the
                //    decoder access unit, so the strict gate sees fresh
                //    _h264ParamsReady on this very payload.
                UpdateParamSetFlags(payload);

                // 2) Reassemble a single, standards-ordered Annex-B access
                //    unit. Returns 0 feeds for parameter-sets-only payloads
                //    (already cached), else 1 feed with SPS+PPS prepended in
                //    front of every IDR for FFmpeg's safety.
                foreach (var feed in ExpandPayloadForDecoder(payload))
                {
                    if (!CanFeedPayload(feed))
                    {
                        // Strict-gate spec: any pre-codecReady payload is
                        // dropped silently. The heartbeat counter ticks.
                        Interlocked.Increment(ref _skippedPreParamFrames);
                        continue;
                    }

                    try
                    {
                        endpoint.GotVideoFrame(remoteEndPoint, timestamp, feed, format);
                    }
                    catch (Exception ex)
                    {
                        if (n <= 5 || n % 60 == 0)
                            OnLog?.Invoke($"[WebRTC] GotVideoFrame error: {ex.Message}");
                    }
                }
            };
        }

        private void LogPayloadShape(byte[] payload, int frameNumber)
        {
            if (payload.Length == 0)
                return;

            // Sample early and then periodically so segment-restart payloads
            // also produce a fresh diagnostic line.
            bool sample = frameNumber <= 30 || frameNumber % 600 == 0;
            if (!sample)
                return;

            var hexLen = Math.Min(12, payload.Length);
            var hex = string.Join(" ", Enumerable.Range(0, hexLen).Select(i => payload[i].ToString("X2")));
            var firstNalType = payload[0] & 0x1f;
            string shape;
            if (payload.Length >= 4 && payload[0] == 0 && payload[1] == 0 &&
                (payload[2] == 1 || (payload[2] == 0 && payload[3] == 1)))
                shape = "annex-b";
            else if (firstNalType == 24)
                shape = "raw-stap-a";
            else if (firstNalType == 28)
                shape = "raw-fu-a";
            else
                shape = $"raw-nal(type={firstNalType})";

            OnLog?.Invoke($"[WebRTC] Frame #{frameNumber} shape={shape} bytes={payload.Length} head={hex}");
        }

        /// <summary>
        /// Strict H.264 admission gate.
        ///
        /// Decoder contract (single source of truth):
        ///   <c>codecReady = SPS_received &amp;&amp; PPS_received &amp;&amp;
        ///   IDR_received_after_them</c>
        ///
        /// No IDR or P payload may reach FFmpeg while <see cref="CodecReady"/>
        /// is false. The first valid IDR after SPS+PPS is the only event that
        /// flips <c>_idrSinceReset</c> to true, opening the gate.
        ///
        /// Rejected payloads are dropped *silently* — counted for diagnostics
        /// (<c>_skippedPreParamFrames</c> shows up in the heartbeat) but never
        /// logged per-frame. This eliminates the noise of pre-gate drops and
        /// prevents FFmpeg from ever seeing input that would produce a spurious
        /// "no frame!" log.
        ///
        /// Behaviour by payload kind:
        ///   • SPS-only or PPS-only feed → silent drop. Already cached by
        ///     <see cref="UpdateParamSetFlags"/>; <see cref="ExpandPayloadForDecoder"/>
        ///     re-injects them in front of the next IDR.
        ///   • IDR → accepted iff <c>_h264ParamsReady</c>; flips
        ///     <c>_idrSinceReset</c>, bumps the counter, flushes the render
        ///     slot, and emits a one-shot gate-open log line.
        ///   • P-frame → accepted iff <see cref="CodecReady"/>.
        ///   • SEI / AUD / filler → pass through.
        /// </summary>
        private bool CanFeedPayload(byte[] payload)
        {
            AnalyzeH264Payload(payload, out var hasSps, out var hasPps, out var hasIdr, out var hasPFrame);

            bool accept;

            if (hasIdr)
            {
                // IDR is the gate opener — only accepted once SPS+PPS are cached.
                accept = _h264ParamsReady;
            }
            else if (hasPFrame)
            {
                // P-frames require the full codecReady sequence.
                accept = CodecReady;
            }
            else if (hasSps || hasPps)
            {
                // Parameter sets — already cached upstream; never fed alone.
                accept = false;
            }
            else
            {
                // SEI / AUD / filler — harmless metadata, pass through.
                accept = true;
            }

            if (accept && hasIdr)
            {
                _idrSinceReset = true;
                Interlocked.Increment(ref _acceptedIdrCount);
                // Arm render path to accept exactly one decoded picture (this
                // IDR). Do NOT flush the render slot here — that is the job of
                // NotifySceneCut and avoids racing stale P-frames in FFmpeg.
                if (_dropDecodedUntilIdr)
                    _acceptNextDecodedFrame = true;

                if (!_codecReadyLogged)
                {
                    _codecReadyLogged = true;
                    OnLog?.Invoke("[WebRTC] Codec ready (SPS+PPS+IDR) — decoding gate OPEN");
                }
            }

            return accept;
        }

        /// <summary>
        /// Cache the SPS/PPS NAL units (without Annex-B start codes) carried
        /// by this RTP payload. Handles every payload shape that SIPSorcery
        /// can deliver — Annex-B byte stream, raw STAP-A aggregate (NAL type
        /// 24), or a single raw NAL — via <see cref="ExtractAllNals"/>.
        ///
        /// Content-aware dedupe: the cache is only rewritten when the new SPS
        /// or PPS bytes differ from what is already cached.
        /// </summary>
        private void UpdateParamSetFlags(byte[] payload)
        {
            var nals = ExtractAllNals(payload);
            bool hasSps = false, hasPps = false;

            foreach (var nal in nals)
            {
                if (!IsValidNal(nal)) continue;
                var t = nal[0] & 0x1f;
                if (t == 7)
                {
                    hasSps = true;
                    lock (_paramSetLock)
                    {
                        if (!ByteArraysEqual(_cachedSpsNal, nal))
                            _cachedSpsNal = (byte[])nal.Clone();
                    }
                }
                else if (t == 8)
                {
                    hasPps = true;
                    lock (_paramSetLock)
                    {
                        if (!ByteArraysEqual(_cachedPpsNal, nal))
                            _cachedPpsNal = (byte[])nal.Clone();
                    }
                }
            }

            if (hasSps && !_loggedSps)
            {
                _loggedSps = true;
                OnLog?.Invoke("[WebRTC] SPS received — decoder params updating");
            }

            if (hasPps && !_loggedPps)
            {
                _loggedPps = true;
                OnLog?.Invoke("[WebRTC] PPS received — decoder params ready");
            }

            if (_cachedSpsNal != null && _cachedPpsNal != null)
                _h264ParamsReady = true;
        }

        private static bool IsValidNal(byte[] nal)
        {
            if (nal == null || nal.Length == 0) return false;
            // forbidden_zero_bit MUST be 0 (RFC 6184 §1.3). Anything else is
            // a malformed NAL — drop without feeding the decoder.
            if ((nal[0] & 0x80) != 0) return false;
            var t = nal[0] & 0x1f;
            // FU-A / FU-B should never appear after RTP depacketization. If
            // they do, it's a depacketizer bug — drop the fragment.
            if (t == 28 || t == 29) return false;
            // STAP-A (24), STAP-B (25), MTAP16 (26), MTAP24 (27) are RTP
            // aggregation packets and must have been unwrapped by ExtractAllNals
            // before reaching this validator.
            if (t >= 24 && t <= 27) return false;
            return true;
        }

        private static bool ByteArraysEqual(byte[]? a, byte[]? b)
        {
            if (ReferenceEquals(a, b)) return true;
            if (a == null || b == null || a.Length != b.Length) return false;
            for (int i = 0; i < a.Length; i++)
                if (a[i] != b[i]) return false;
            return true;
        }

        /// <summary>
        /// Build one canonical-order Annex-B access unit from a SIPSorcery
        /// payload, ready to feed to FFmpeg.
        ///
        /// Inputs handled (post FU-A reassembly done by SIPSorcery):
        ///   • Annex-B byte stream (with 3- or 4-byte start codes)
        ///   • raw STAP-A aggregate (NAL type 24)
        ///   • a single raw NAL unit
        ///
        /// NALs are validated (<see cref="IsValidNal"/>), then bucketed by
        /// type and emitted in the order mandated by H.264 §7.4.1.2.3:
        ///
        ///   AUD → SEI → SPS → PPS → primary VCL → other
        ///
        /// Stability-first SPS/PPS injection policy: every IDR slice is
        /// prefixed with the current SPS+PPS — preferring bytes from this AU
        /// if present, else from the cache populated by UpdateParamSetFlags.
        /// This is idempotent for FFmpeg (it dedupes identical parameter
        /// sets) and provides defence-in-depth against parameter-set loss
        /// or decoder state resets we cannot observe from outside the lib.
        ///
        /// Parameter-set-only payloads (no VCL) are silently consumed — they
        /// were cached upstream and FFmpeg never wants a lone SPS+PPS feed
        /// (it would log "no frame!" because no picture is produced).
        /// </summary>
        private IReadOnlyList<byte[]> ExpandPayloadForDecoder(byte[] payload)
        {
            var nals = ExtractAllNals(payload);
            if (nals.Count == 0)
                return Array.Empty<byte[]>();

            // Bucket NALs in canonical-order containers.
            var aud  = new List<byte[]>();  // type 9
            var sei  = new List<byte[]>();  // type 6
            var sps  = new List<byte[]>();  // type 7
            var pps  = new List<byte[]>();  // type 8
            var vcl  = new List<byte[]>();  // types 1 + 5
            var rest = new List<byte[]>();  // everything else valid
            bool hasIdr = false;

            foreach (var nal in nals)
            {
                if (!IsValidNal(nal)) continue;
                var t = nal[0] & 0x1f;
                switch (t)
                {
                    case 9: aud.Add(nal); break;
                    case 6: sei.Add(nal); break;
                    case 7: sps.Add(nal); break;
                    case 8: pps.Add(nal); break;
                    case 1: vcl.Add(nal); break;
                    case 5: vcl.Add(nal); hasIdr = true; break;
                    default: rest.Add(nal); break;
                }
            }

            // No VCL ⇒ pure parameter-set / SEI / AUD payload. Cached upstream
            // by UpdateParamSetFlags; nothing useful to hand to FFmpeg.
            if (vcl.Count == 0)
                return Array.Empty<byte[]>();

            var unit = new List<byte[]>(aud.Count + sei.Count + 2 + vcl.Count + rest.Count);
            unit.AddRange(aud);
            unit.AddRange(sei);

            // Always re-inject SPS+PPS in front of every IDR — prefer the
            // bytes from THIS access unit if present, else fall back to the
            // cache. Re-injection is idempotent for FFmpeg and survives
            // any unobservable internal decoder-state changes.
            if (hasIdr)
            {
                if (sps.Count > 0)
                {
                    unit.AddRange(sps);
                }
                else
                {
                    lock (_paramSetLock)
                    {
                        if (_cachedSpsNal != null) unit.Add(_cachedSpsNal);
                    }
                }

                if (pps.Count > 0)
                {
                    unit.AddRange(pps);
                }
                else
                {
                    lock (_paramSetLock)
                    {
                        if (_cachedPpsNal != null) unit.Add(_cachedPpsNal);
                    }
                }
            }

            unit.AddRange(vcl);
            unit.AddRange(rest);

            return new[] { BuildAnnexBAccessUnit(unit) };
        }

        /// <summary>
        /// Extract every NAL unit from a payload, regardless of input shape:
        /// Annex-B (3 or 4 byte start codes), raw STAP-A at offset 0, or a single
        /// raw NAL unit. STAP-A units found inside Annex-B are also unwrapped.
        /// </summary>
        private static List<byte[]> ExtractAllNals(byte[] payload)
        {
            var result = new List<byte[]>();
            if (payload == null || payload.Length == 0)
                return result;

            var annexBNals = ExtractAnnexBNals(payload);
            if (annexBNals.Count > 0)
            {
                foreach (var nal in annexBNals)
                {
                    if (nal.Length == 0) continue;
                    if ((nal[0] & 0x1f) == 24)
                        result.AddRange(UnwrapStapA(nal, 1));
                    else
                        result.Add(nal);
                }
                return result;
            }

            if ((payload[0] & 0x1f) == 24)
                return UnwrapStapA(payload, 1);

            result.Add(payload);
            return result;
        }

        private static List<byte[]> UnwrapStapA(byte[] payload, int startOffset)
        {
            var nals = new List<byte[]>();
            int pos = startOffset;
            while (pos + 2 <= payload.Length)
            {
                int nalLen = (payload[pos] << 8) | payload[pos + 1];
                pos += 2;
                if (nalLen <= 0 || pos + nalLen > payload.Length)
                    break;
                var nal = new byte[nalLen];
                Buffer.BlockCopy(payload, pos, nal, 0, nalLen);
                nals.Add(nal);
                pos += nalLen;
            }
            return nals;
        }

        private static List<byte[]> ExtractAnnexBNals(byte[] payload)
        {
            var nals = new List<byte[]>();
            int i = 0;
            while (i < payload.Length - 3)
            {
                int start = FindStartCode(payload, i, out int scLen);
                if (start < 0)
                    break;

                int nalBegin = start + scLen;
                int next = FindStartCode(payload, nalBegin, out _);
                int end = next < 0 ? payload.Length : next;
                if (end > nalBegin)
                {
                    var nal = new byte[end - nalBegin];
                    Buffer.BlockCopy(payload, nalBegin, nal, 0, nal.Length);
                    nals.Add(nal);
                }

                i = end > nalBegin ? end : nalBegin + 1;
            }

            return nals;
        }

        private static byte[] BuildAnnexBAccessUnit(IReadOnlyList<byte[]> nals)
        {
            int size = 0;
            foreach (var n in nals)
                size += 4 + n.Length;

            var buf = new byte[size];
            int pos = 0;
            foreach (var n in nals)
            {
                buf[pos++] = 0;
                buf[pos++] = 0;
                buf[pos++] = 0;
                buf[pos++] = 1;
                Buffer.BlockCopy(n, 0, buf, pos, n.Length);
                pos += n.Length;
            }

            return buf;
        }

        private static int FindStartCode(byte[] payload, int from, out int startCodeLength)
        {
            startCodeLength = 0;
            for (int i = from; i < payload.Length - 3; i++)
            {
                if (payload[i] == 0 && payload[i + 1] == 0)
                {
                    if (payload[i + 2] == 1)
                    {
                        startCodeLength = 3;
                        return i;
                    }

                    if (i + 3 < payload.Length && payload[i + 2] == 0 && payload[i + 3] == 1)
                    {
                        startCodeLength = 4;
                        return i;
                    }
                }
            }

            return -1;
        }

        private static void AnalyzeH264Payload(
            byte[] payload,
            out bool hasSps,
            out bool hasPps,
            out bool hasIdr,
            out bool hasPFrame)
        {
            hasSps = hasPps = hasIdr = hasPFrame = false;
            if (payload == null || payload.Length < 1)
                return;

            foreach (var nal in ExtractAllNals(payload))
            {
                if (nal.Length == 0) continue;
                NoteNalType(nal[0], ref hasSps, ref hasPps, ref hasIdr, ref hasPFrame);
            }
        }

        private static void NoteNalType(
            byte nalHeaderByte,
            ref bool hasSps,
            ref bool hasPps,
            ref bool hasIdr,
            ref bool hasPFrame)
        {
            int t = nalHeaderByte & 0x1f;
            switch (t)
            {
                case 7: hasSps = true; break;
                case 8: hasPps = true; break;
                case 5: hasIdr = true; break;
                case 1: hasPFrame = true; break;
            }
        }

        private void ScheduleMediaWatch()
        {
            _mediaWatchCts?.Cancel();
            _mediaWatchCts?.Dispose();
            _mediaWatchCts = new CancellationTokenSource();
            _mediaWatchStartedTicks = Stopwatch.GetTimestamp();
            var token = _mediaWatchCts.Token;

            _ = Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(45000, token);
                }
                catch (TaskCanceledException)
                {
                    return;
                }

                if (token.IsCancellationRequested)
                    return;

                if (_encodedFrameCount == 0)
                {
                    OnError?.Invoke("[WebRTC] No video frames after 45s — check server capture and ICE.");
                }
                else if (_decodePublished == 0)
                {
                    var fmt = _activeVideoFormat.HasValue
                        ? $"{_activeVideoFormat.Value.FormatName} PT={_activeVideoFormat.Value.FormatID}"
                        : "not configured";
                    OnError?.Invoke($"[WebRTC] {_encodedFrameCount} encoded frames but 0 decoded. Decoder: {fmt}.");
                }
            }, token);
        }

        private void CancelMediaWatch() => _mediaWatchCts?.Cancel();

        private double MediaWatchElapsedSeconds() =>
            _mediaWatchStartedTicks == 0
                ? 0
                : (Stopwatch.GetTimestamp() - _mediaWatchStartedTicks) / (double)Stopwatch.Frequency;

        public async Task HandleOfferAsync(string sdpOffer)
        {
            if (_peerConnection == null)
            {
                if (!await InitializePeerAsync(_currentSessionId ?? "default"))
                {
                    OnError?.Invoke("[WebRTC] Failed to initialize peer for offer");
                    return;
                }
            }

            try
            {
                SetSignalingRelay(true);
                OnLog?.Invoke("[WebRTC] Processing SDP offer...");
                var offer = new RTCSessionDescriptionInit
                {
                    type = RTCSdpType.offer,
                    sdp = sdpOffer
                };

                var result = _peerConnection!.setRemoteDescription(offer);
                if (result != SetDescriptionResultEnum.OK)
                {
                    var hint = result == SetDescriptionResultEnum.VideoIncompatible
                        ? " Server SDP must offer H.264."
                        : string.Empty;
                    OnError?.Invoke($"[WebRTC] setRemoteDescription failed: {result}.{hint}");
                    return;
                }

                _hasRemoteDescription = true;
                ConfigureDecoderFromRemoteOffer(sdpOffer);

                var answer = _peerConnection.createAnswer();
                await _peerConnection.setLocalDescription(answer);
                ConfigureDecoderFromSdp(answer.sdp, "answer");

                OnAnswerCreated?.Invoke(answer.sdp);

                foreach (var candidate in _pendingCandidates)
                    _peerConnection.addIceCandidate(candidate);
                _pendingCandidates.Clear();

                OnStreamStatusChanged?.Invoke(StreamStatus.Starting);
                ScheduleMediaWatch();
                OnLog?.Invoke($"[WebRTC] Answer sent — waiting for media (elapsed {MediaWatchElapsedSeconds():F1}s)");
            }
            catch (Exception ex)
            {
                OnError?.Invoke($"[WebRTC] Failed to handle offer: {ex.Message}");
                OnStreamStatusChanged?.Invoke(StreamStatus.Error);
            }
        }

        public async Task HandleAnswerAsync(string sdpAnswer)
        {
            if (_peerConnection == null)
            {
                OnError?.Invoke("[WebRTC] Cannot handle answer: peer not initialized");
                return;
            }

            try
            {
                var answer = new RTCSessionDescriptionInit
                {
                    type = RTCSdpType.answer,
                    sdp = sdpAnswer
                };

                var result = _peerConnection.setRemoteDescription(answer);
                if (result != SetDescriptionResultEnum.OK)
                {
                    OnError?.Invoke($"[WebRTC] setRemoteDescription (answer) failed: {result}");
                    return;
                }

                _hasRemoteDescription = true;
                foreach (var candidate in _pendingCandidates)
                    _peerConnection.addIceCandidate(candidate);
                _pendingCandidates.Clear();
            }
            catch (Exception ex)
            {
                OnError?.Invoke($"[WebRTC] Failed to handle answer: {ex.Message}");
            }
        }

        public Task HandleIceCandidateAsync(string candidateJson)
        {
            try
            {
                using var doc = JsonDocument.Parse(candidateJson);
                var root = doc.RootElement;

                string? candidateStr = null;
                string? sdpMid = null;
                ushort sdpMLineIndex = 0;

                if (root.TryGetProperty("candidate", out var candElem))
                {
                    candidateStr = candElem.ValueKind == JsonValueKind.String
                        ? candElem.GetString()
                        : candElem.TryGetProperty("candidate", out var nestedCand)
                            ? nestedCand.GetString()
                            : null;
                }
                if (root.TryGetProperty("sdpMid", out var midElem))
                    sdpMid = midElem.GetString();
                if (root.TryGetProperty("sdpMLineIndex", out var indexElem) &&
                    indexElem.ValueKind == JsonValueKind.Number)
                    sdpMLineIndex = (ushort)indexElem.GetInt32();

                if (string.IsNullOrEmpty(candidateStr))
                    return Task.CompletedTask;

                var iceCandidate = new RTCIceCandidateInit
                {
                    candidate = candidateStr,
                    sdpMid = sdpMid ?? "0",
                    sdpMLineIndex = sdpMLineIndex
                };

                if (_peerConnection != null && _hasRemoteDescription)
                    _peerConnection.addIceCandidate(iceCandidate);
                else
                    _pendingCandidates.Add(iceCandidate);
            }
            catch (Exception ex)
            {
                OnError?.Invoke($"[WebRTC] Failed to handle ICE candidate: {ex.Message}");
            }

            return Task.CompletedTask;
        }

        private static bool IsH264Format(VideoFormat format) =>
            format.Codec.ToString().Contains("H264", StringComparison.OrdinalIgnoreCase) ||
            (format.FormatName?.Contains("H264", StringComparison.OrdinalIgnoreCase) ?? false);

        private static List<VideoFormat> FilterH264Formats(List<VideoFormat> formats)
        {
            var h264 = formats.Where(IsH264Format).ToList();
            return h264.Count > 0 ? h264 : formats;
        }

        private static VideoFormat PickH264Format(IEnumerable<VideoFormat> formats)
        {
            foreach (var f in formats)
            {
                if (IsH264Format(f))
                    return f;
            }
            return formats.First();
        }

        private void ApplyDecoderFormat(VideoFormat format, string reason)
        {
            if (_videoEndPoint == null)
                return;

            _videoEndPoint.SetVideoSinkFormat(format);
            _activeVideoFormat = format;
            OnLog?.Invoke($"[WebRTC] Decoder ({reason}): {format.FormatName} PT={format.FormatID}");
        }

        private void ConfigureDecoderFromRemoteOffer(string sdpOffer) =>
            ConfigureDecoderFromSdp(sdpOffer, "offer");

        private void ConfigureDecoderFromSdp(string sdp, string reason)
        {
            if (_videoEndPoint == null)
                return;

            var formats = FilterH264Formats(_videoEndPoint.GetVideoSinkFormats());
            int? pt = null;
            var rtpmapMatch = Regex.Match(sdp, @"a=rtpmap:(\d+)\s+H264/90000", RegexOptions.IgnoreCase);
            if (rtpmapMatch.Success)
                pt = int.Parse(rtpmapMatch.Groups[1].Value);

            var baseFmt = PickH264Format(formats);
            var chosen = pt.HasValue && baseFmt.FormatID != pt.Value
                ? new VideoFormat(VideoCodecsEnum.H264, pt.Value)
                : baseFmt;

            ApplyDecoderFormat(chosen, reason);
        }

        public async Task<bool> PrepareStreamAsync(string sessionId)
        {
            OnLog?.Invoke($"[WebRTC] Preparing stream for session: {sessionId}");
            OnStreamStatusChanged?.Invoke(StreamStatus.Starting);
            return await InitializePeerAsync(sessionId);
        }

        public void OnStreamStarted() =>
            OnLog?.Invoke("[WebRTC] Stream started — waiting for WebRTC negotiation");

        /// <summary>
        /// Server-side scene-change hint.
        ///
        /// Stability-first policy: this is a RENDER-side flush only. No
        /// decoder state, no peer state, no H.264 admission state is touched.
        ///
        ///   ✗ NOT reset: FFmpeg decoder / video endpoint
        ///   ✗ NOT reset: WebRTC peer / DTLS / ICE
        ///   ✗ NOT reset: SPS/PPS cache
        ///   ✗ NOT reset: <c>_idrSinceReset</c> — closing the strict gate
        ///                here caused "scene_cut drops" because single-shot
        ///                screenrecord rarely emits a fresh natural IDR
        ///                soon enough to re-open it.
        ///   ✓ Flush the decoded-frame slot so a stale P-frame cannot be
        ///     presented on top of the new keyframe the server is about to
        ///     send (the corresponding RTP IDR is what actually carries the
        ///     fresh reference picture).
        ///
        /// The server's scene_cut WebSocket message and the matching RTP
        /// STAP-A + IDR travel on independent transports. Because we no
        /// longer mutate any gate state in response to the JSON, JSON-vs-RTP
        /// ordering races cannot produce drops or SPS/PPS desync.
        /// </summary>
        public void NotifySceneCut()
        {
            _dropDecodedUntilIdr = true;
            _acceptNextDecodedFrame = false;
            try { OnSceneCut?.Invoke(); }
            catch { /* render-side flush must never fault the WebRTC path */ }
            OnLog?.Invoke("[WebRTC] Scene cut hint — render slot flushed (gate, decoder, peer all kept intact)");
        }

        public void StopStream()
        {
            OnLog?.Invoke("[WebRTC] Stopping stream...");
            ClosePeer();
            OnStreamStatusChanged?.Invoke(StreamStatus.Stopped);
        }

        private void EmitOrQueueIceCandidate(string candidateJson)
        {
            if (!_signalingRelayEnabled)
            {
                lock (_pendingOutboundIce)
                    _pendingOutboundIce.Add(candidateJson);
                return;
            }

            OnIceCandidateGenerated?.Invoke(candidateJson);
        }

        public void ClosePeer()
        {
            SetSignalingRelay(false);

            if (_videoEndPoint != null)
            {
                try
                {
                    _videoEndPoint.OnVideoSinkDecodedSampleFaster -= HandleDecodedVideoFrame;
                    _videoEndPoint.Dispose();
                }
                catch { }
                _videoEndPoint = null;
            }

            if (_peerConnection != null)
            {
                if (_onIceCandidateHandler != null)
                {
                    try { _peerConnection.onicecandidate -= _onIceCandidateHandler; }
                    catch { }
                    _onIceCandidateHandler = null;
                }
                try { _peerConnection.close(); }
                catch { }
                _peerConnection = null;
            }

            CancelMediaWatch();
            _h264ParamsReady = false;
            _idrSinceReset = false;
            _codecReadyLogged = false;
            _loggedSps = false;
            _loggedPps = false;
            _dropDecodedUntilIdr = false;
            _acceptNextDecodedFrame = false;
            lock (_paramSetLock)
            {
                _cachedSpsNal = null;
                _cachedPpsNal = null;
            }
            _mediaWatchCts?.Dispose();
            _mediaWatchCts = null;
            _mediaWatchStartedTicks = 0;
            _currentSessionId = null;
            _hasRemoteDescription = false;
            _pendingCandidates.Clear();
            _encodedFrameCount = 0;
            _decodePublished = 0;
            _acceptedIdrCount = 0;
            _skippedPreParamFrames = 0;
            _activeVideoFormat = null;
            _firstFrameTicks = 0;
        }

        public static string CreateStartStreamMessage(string sessionId, string deviceId) =>
            JsonSerializer.Serialize(new { type = "start_stream", session_id = sessionId, device_id = deviceId });

        public static string CreateStopStreamMessage(string sessionId) =>
            JsonSerializer.Serialize(new { type = "stop_stream", session_id = sessionId });

        public static string CreateWebRTCAnswerMessage(string sessionId, string sdp) =>
            JsonSerializer.Serialize(new { type = "webrtc_answer", session_id = sessionId, sdp });

        public static string CreateIceCandidateMessage(string sessionId, string candidate) =>
            JsonSerializer.Serialize(new { type = "ice_candidate", session_id = sessionId, candidate });

        public void Dispose()
        {
            if (_disposed)
                return;
            _disposed = true;
            ClosePeer();
            GC.SuppressFinalize(this);
        }
    }

    public enum StreamStatus
    {
        Idle,
        Initialized,
        Starting,
        Active,
        Stopped,
        Error
    }
}
