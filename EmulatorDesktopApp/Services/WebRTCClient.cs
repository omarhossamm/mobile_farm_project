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
using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using FFmpeg.AutoGen;
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
    /// <summary>
    /// Intercepts FFmpeg internal log messages routed through SIPSorceryMedia.FFmpeg's
    /// ILogger sink.  One static instance is shared across all sessions (FFmpegInit is
    /// called once per process); per-session counts are reset via
    /// <see cref="ResetForSession"/>.
    /// </summary>
    private sealed class AbDiagnosticsLogger : ILogger
    {
        private int _concealmentFrames;
        private int _ffmpegErrors;
        private int _ffmpegWarnings;

        public int ConcealmentFrames => Volatile.Read(ref _concealmentFrames);
        public int FfmpegErrors      => Volatile.Read(ref _ffmpegErrors);
        public int FfmpegWarnings    => Volatile.Read(ref _ffmpegWarnings);

        /// <summary>Forward filtered FFmpeg messages to the UI log (set per session).</summary>
        public Action<string>? Sink { get; set; }

        public void ResetForSession()
        {
            Interlocked.Exchange(ref _concealmentFrames, 0);
            Interlocked.Exchange(ref _ffmpegErrors, 0);
            Interlocked.Exchange(ref _ffmpegWarnings, 0);
        }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Warning;

        public void Log<TState>(
            LogLevel logLevel, EventId eventId, TState state,
            Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;
            var msg = formatter(state, exception);
            if (msg.Contains("concealing", StringComparison.OrdinalIgnoreCase)
                || msg.Contains("no frame!", StringComparison.OrdinalIgnoreCase)
                || msg.Contains("non-existing PPS", StringComparison.OrdinalIgnoreCase)
                || msg.Contains("co located POCs", StringComparison.OrdinalIgnoreCase))
            {
                Interlocked.Increment(ref _concealmentFrames);
                Sink?.Invoke($"[FFMPEG] {msg.Trim()}");
            }
            else if (logLevel >= LogLevel.Error)
            {
                Interlocked.Increment(ref _ffmpegErrors);
                Sink?.Invoke($"[FFMPEG-ERR] {msg.Trim()}");
            }
            else
            {
                Interlocked.Increment(ref _ffmpegWarnings);
            }
        }
    }

    /// <summary>Singleton FFmpeg log interceptor — shared for the process lifetime.</summary>
    private static readonly AbDiagnosticsLogger _diagLogger = new();

    private static bool _loggingInitialized;
    private static bool _ffmpegInitialized;
    private static string? _ffmpegLoadDiag;
    private bool _disposed;
        private RTCPeerConnection? _peerConnection;
        private FFmpegVideoEndPoint? _videoEndPoint;

        // Serializes native FFmpeg decode (GotVideoFrame on the RTP receive
        // thread) against decoder disposal (ClosePeer on the stop/UI thread).
        // Without it, destroying the session while a frame is mid-decode frees
        // the native AVCodecContext under the decode call → SIGSEGV (exit 139).
        private readonly object _decodeLock = new object();
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
        // Interaction-correlated freeze watchdog. The server-side WebRTC transport
        // can silently die (RTP stops arriving) while ICE/DTLS still report
        // "connected", leaving a permanently frozen picture. We can only safely
        // distinguish that from a legitimately static screen by user intent: if the
        // user injects input but no RTP follows within the grace window, the media
        // path is genuinely stuck and a full re-negotiation is required.
        private CancellationTokenSource? _freezeWatchCts;
        private long _lastRtpAtTicks;
        private long _lastInputAtTicks;
        private long _lastRecoveryAtTicks;
        private const int FreezeGraceMs = 2500;
        private const int FreezeRecoveryCooldownMs = 8000;
        private Action<RTCIceCandidate>? _onIceCandidateHandler;
        private int _iceCandidateLogCount;
        private volatile bool _signalingRelayEnabled;
        private readonly List<string> _pendingOutboundIce = new();
        private readonly SemaphoreSlim _offerNegotiationLock = new(1, 1);
        private bool _loggedNonPrimaryVideoStream;
        private RtpVideoFramer? _unifiedH264Framer;
        private int _videoRtpPacketsReceived;

        private RTCDataChannel? _controlChannel;

        // ── A/B provider comparison diagnostics ─────────────────────────────
        private Timer? _statsTimer;
        private long   _firstDecodedFrameTicks;
        private long   _statsSessionStartTicks;

        // ── Scene-cut watchdog ───────────────────────────────────────────────
        //
        // When NotifySceneCut() sets _dropDecodedUntilIdr = true, every decoded
        // frame is dropped until the next accepted IDR picture arrives.  This
        // is correct for the normal case (IDR follows within 0.5 s given the
        // server's gopFrames = fps/2 setting).
        //
        // However, if the server stalls (network hiccup, encoder restart) after
        // the scene-cut hint, no IDR may arrive for several seconds — leaving
        // _dropDecodedUntilIdr permanently true and the screen frozen/black.
        //
        // The watchdog fires SCENE_CUT_WATCHDOG_SEC after the last scene-cut.
        // If _dropDecodedUntilIdr is still true at that point it resets the
        // flag so the next decoded frame (even a P-frame) is presented, giving
        // the user a visible picture while waiting for the next clean IDR.
        // This is a graceful-degradation path: a brief artifact is far less
        // disruptive than an indefinite black screen.
        private Timer?  _sceneCutWatchdog;
        private long    _sceneCutActivatedTicks;
        private const double SceneCutWatchdogSec = 5.0;

        private static void EnsureLoggingInitialized()
        {
            if (!_loggingInitialized)
            {
                SIPSorcery.LogFactory.Set(new NullLoggerFactory());
                _loggingInitialized = true;
            }
        }

        /// <summary>Subfolder under the app output where Windows FFmpeg DLLs live (avoids polluting the exe directory).</summary>
        private static string WindowsFfmpegSubdir =>
            Path.Combine(AppContext.BaseDirectory, "ffmpeg", "win-x64");

        /// <summary>
        /// Locate FFmpeg shared libraries. Search order:
        ///   1. FFMPEG_LIB_PATH override.
        ///   2. App output ffmpeg/win-x64 (bundled by FFmpeg.Windows.targets).
        ///   3. Project ffmpeg/win-x64 folder (dotnet run without a fresh build).
        ///   4. winget Gyan FFmpeg (Shared) install, if present.
        ///   5. Homebrew paths (macOS).
        /// </summary>
        private static string? ResolveFfmpegLibPath()
        {
            if (OperatingSystem.IsWindows())
                EnsureWindowsFfmpegBesideExecutable();

            var fromEnv = Environment.GetEnvironmentVariable("FFMPEG_LIB_PATH");
            if (DirectoryHasFfmpeg(fromEnv))
                return fromEnv;

            foreach (var path in BundledFfmpegSearchDirs())
            {
                if (DirectoryHasFfmpeg(path))
                    return path;
            }

            if (OperatingSystem.IsMacOS())
            {
                string[] homebrew =
                {
                    "/opt/homebrew/lib",
                    "/opt/homebrew/opt/ffmpeg/lib",
                    "/usr/local/lib",
                    "/usr/local/opt/ffmpeg/lib"
                };
                foreach (var path in homebrew)
                {
                    if (DirectoryHasFfmpeg(path))
                        return path;
                }
            }

            return null;
        }

        /// <summary>Directories to probe for bundled FFmpeg (Windows subfolder + project bundle + winget).</summary>
        private static IEnumerable<string> BundledFfmpegSearchDirs()
        {
            if (OperatingSystem.IsWindows())
            {
                yield return WindowsFfmpegSubdir;
                yield return Path.Combine(AppContext.BaseDirectory, "ffmpeg");
                foreach (var path in EnumerateProjectFfmpegBundleDirs())
                    yield return path;
                foreach (var path in EnumerateWingetFfmpegDirs())
                    yield return path;
                yield break;
            }

            var baseDir = AppContext.BaseDirectory;
            yield return baseDir;
            yield return Path.Combine(baseDir, "ffmpeg");
            string rid = RuntimeInformation.ProcessArchitecture == Architecture.Arm64
                ? "win-arm64" : "win-x64";
            yield return Path.Combine(baseDir, "runtimes", rid, "native");
        }

        /// <summary>Walk up from the app folder looking for ffmpeg/win-x64 (repo layout).</summary>
        private static IEnumerable<string> EnumerateProjectFfmpegBundleDirs()
        {
            if (!OperatingSystem.IsWindows())
                yield break;

            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            for (var i = 0; i < 6 && dir != null; i++, dir = dir.Parent)
            {
                yield return Path.Combine(dir.FullName, "ffmpeg", "win-x64");
                yield return Path.Combine(dir.FullName, "EmulatorDesktopApp", "ffmpeg", "win-x64");
            }
        }

        /// <summary>winget: Gyan.FFmpeg.Shared installs under LocalAppData\Microsoft\WinGet\Packages\...</summary>
        private static IEnumerable<string> EnumerateWingetFfmpegDirs()
        {
            if (!OperatingSystem.IsWindows())
                yield break;

            var wingetRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Microsoft", "WinGet", "Packages");
            if (!Directory.Exists(wingetRoot))
                yield break;

            foreach (var pkg in Directory.EnumerateDirectories(wingetRoot, "Gyan.FFmpeg.Shared*"))
            {
                foreach (var bin in Directory.EnumerateDirectories(pkg, "ffmpeg-*-full_build-shared", SearchOption.AllDirectories))
                {
                    var binDir = Path.Combine(bin, "bin");
                    if (Directory.Exists(binDir))
                        yield return binDir;
                }
            }
        }

        /// <summary>
        /// If the bundle exists in the project tree but not under the app output, copy it now.
        /// </summary>
        private static void EnsureWindowsFfmpegBesideExecutable()
        {
            var destDir = WindowsFfmpegSubdir;
            if (DirectoryHasFfmpeg(destDir))
                return;

            foreach (var src in EnumerateProjectFfmpegBundleDirs())
            {
                if (!DirectoryHasFfmpeg(src))
                    continue;

                Directory.CreateDirectory(destDir);
                foreach (var name in WindowsRequiredFfmpegDlls)
                    File.Copy(Path.Combine(src, name), Path.Combine(destDir, name), overwrite: true);
                return;
            }
        }

        /// <summary>Load order for Gyan codexffmpeg 8.1 shared DLLs (dependencies first).</summary>
        private static readonly string[] WindowsFfmpegLoadOrder =
        {
            "avutil-60.dll", "swresample-6.dll", "swscale-9.dll",
            "avcodec-62.dll", "avformat-62.dll", "avfilter-11.dll", "avdevice-62.dll"
        };

        private static readonly string[] WindowsRequiredFfmpegDlls = WindowsFfmpegLoadOrder;

        private static bool DirectoryHasFfmpeg(string? dir)
        {
            if (string.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir))
                return false;

            if (OperatingSystem.IsWindows())
            {
                foreach (var name in WindowsRequiredFfmpegDlls)
                {
                    if (!File.Exists(Path.Combine(dir, name)))
                        return false;
                }
                return true;
            }

            string pattern = OperatingSystem.IsMacOS() ? "libavutil*.dylib" : "libavutil*.so*";
            return Directory.GetFiles(dir, pattern).Length > 0;
        }

        private static string NormalizeFfmpegRoot(string dir) =>
            Path.GetFullPath(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
            + Path.DirectorySeparatorChar;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool SetDllDirectory(string? lpPathName);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr LoadLibraryEx(string lpLibFileName, IntPtr hFile, uint dwFlags);

        private const uint LOAD_WITH_ALTERED_SEARCH_PATH = 0x00000008;
        private const ushort PeMachineAmd64 = 0x8664;

        /// <summary>Extended-length path prefix — required for LoadLibraryEx when the path contains spaces.</summary>
        private static string ToExtendedPath(string path)
        {
            var full = Path.GetFullPath(path);
            if (full.StartsWith(@"\\?\", StringComparison.Ordinal))
                return full;
            return full.StartsWith(@"\\", StringComparison.Ordinal)
                ? @"\\?\UNC\" + full[2..]
                : @"\\?\" + full;
        }

        private static bool IsAmd64NativeDll(string path)
        {
            try
            {
                using var fs = File.OpenRead(path);
                using var br = new BinaryReader(fs);
                if (br.ReadUInt16() != 0x5A4D)
                    return false;
                fs.Seek(0x3C, SeekOrigin.Begin);
                int peOffset = br.ReadInt32();
                if (peOffset <= 0 || peOffset > fs.Length - 6)
                    return false;
                fs.Seek(peOffset + 4, SeekOrigin.Begin);
                return br.ReadUInt16() == PeMachineAmd64;
            }
            catch
            {
                return false;
            }
        }

        private static string? DiagnoseWindowsFfmpegLoadFailure(int win32Error)
        {
            var missingVc = new List<string>();
            foreach (var name in new[] { "vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll" })
            {
                if (!File.Exists(Path.Combine(Environment.SystemDirectory, name)))
                    missingVc.Add(name);
            }

            var bitness = Environment.Is64BitProcess ? "64-bit" : "32-bit";
            var hints = new List<string> { $"process is {bitness} (must be 64-bit)" };

            if (missingVc.Count > 0)
            {
                hints.Add($"missing VC++ runtime ({string.Join(", ", missingVc)}) — run: winget install Microsoft.VCRedist.2015+.x64");
            }
            else if (win32Error is 126 or 127)
            {
                hints.Add("install/repair VC++ x64: winget install Microsoft.VCRedist.2015+.x64");
            }

            if (win32Error == 193)
                hints.Add("FFmpeg DLL architecture mismatch — run 'dotnet clean' then 'dotnet build' on Windows");

            return string.Join("; ", hints);
        }

        private static void PinWindowsNativeDllSearch(string libPath) =>
            SetDllDirectory(libPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));

        private static void PreloadWindowsFfmpeg(string libPath)
        {
            var avutilPath = Path.Combine(libPath, "avutil-60.dll");
            if (!File.Exists(avutilPath))
                throw new FileNotFoundException($"FFmpeg avutil-60.dll not found at {avutilPath}");

            var avutilSize = new FileInfo(avutilPath).Length;
            if (avutilSize < 100_000)
                throw new InvalidDataException(
                    $"FFmpeg avutil-60.dll at {avutilPath} looks invalid ({avutilSize} bytes). " +
                    "Run 'dotnet build' on Windows to re-download the Gyan codexffmpeg 8.1 bundle.");

            if (!Environment.Is64BitProcess)
            {
                throw new DllNotFoundException(
                    "FFmpeg requires a 64-bit process. Rebuild with PlatformTarget=x64 (already set in csproj).");
            }

            if (!IsAmd64NativeDll(avutilPath))
            {
                throw new BadImageFormatException(
                    $"FFmpeg avutil-60.dll at {avutilPath} is not a 64-bit DLL. " +
                    "Delete ffmpeg\\win-x64\\ and bin\\Debug\\net10.0\\ffmpeg\\, then run 'dotnet clean' and 'dotnet build'.");
            }

            var loaded = 0;
            var failures = new List<string>();
            int firstError = 0;
            foreach (var name in WindowsFfmpegLoadOrder)
            {
                var dll = Path.Combine(libPath, name);
                if (LoadLibraryEx(ToExtendedPath(dll), IntPtr.Zero, LOAD_WITH_ALTERED_SEARCH_PATH) == IntPtr.Zero)
                {
                    var err = Marshal.GetLastWin32Error();
                    if (firstError == 0) firstError = err;
                    failures.Add($"{name} (Win32={err})");
                }
                else
                {
                    loaded++;
                }
            }

            var bitness = Environment.Is64BitProcess ? "64-bit" : "32-bit";
            _ffmpegLoadDiag = failures.Count == 0
                ? $"preloaded {loaded} FFmpeg DLL(s) from {libPath} ({bitness} process)"
                : $"preloaded {loaded} FFmpeg DLL(s) from {libPath} ({bitness} process); failed: {string.Join(", ", failures)}";

            if (failures.Count > 0)
            {
                var hint = DiagnoseWindowsFfmpegLoadFailure(firstError);
                throw new DllNotFoundException($"{_ffmpegLoadDiag}. {hint}");
            }
        }

        private static void EnsureFfmpegInitialized()
        {
            if (_ffmpegInitialized)
                return;

            EnsureLoggingInitialized();
            var libPath = ResolveFfmpegLibPath();

            if (OperatingSystem.IsWindows())
            {
                if (libPath == null)
                {
                    throw new DllNotFoundException(
                        "Unable to find FFMPEG binaries. Rebuild on Windows (dotnet build) to auto-download " +
                        "the Gyan codexffmpeg 8.1 DLLs into ffmpeg\\win-x64\\, " +
                        "or set FFMPEG_LIB_PATH to a folder containing avutil-60.dll and the other FFmpeg 8.x DLLs.");
                }

                libPath = NormalizeFfmpegRoot(libPath);
                PinWindowsNativeDllSearch(libPath);
                PreloadWindowsFfmpeg(libPath);
                ffmpeg.RootPath = libPath;
            }

            if (libPath != null)
                FFmpegInit.Initialise(
                    logLevel: FfmpegLogLevelEnum.AV_LOG_WARNING,
                    libPath: libPath,
                    appLogger: _diagLogger);
            else
                FFmpegInit.Initialise(
                    logLevel: FfmpegLogLevelEnum.AV_LOG_WARNING,
                    appLogger: _diagLogger);

            // Cap FFmpeg's native log verbosity to ERROR.
            //
            // AV_LOG_WARNING lets through one benign line per stream startup
            // from libswscale:
            //   "[swscaler @ 0x...] No accelerated colorspace conversion
            //    found from yuv420p to rgb24"
            // — SIPSorceryMedia.FFmpeg 10.0.7 hard-codes the decoder output
            // as rgb24 and libswscale has no SIMD path for yuv420p→rgb24, so
            // it falls back to a C loop. That is FINE for 720x1280@30fps
            // (well within scalar CPU throughput) but the message keeps
            // scaring operators. Real problems (concealment frames, missing
            // PPS, decoder errors) come through at ERROR level and are still
            // captured by AbDiagnosticsLogger above.
            //
            // If you ever need the warnings back for diagnosing corruption,
            // change the level here to AV_LOG_WARNING.
            ffmpeg.av_log_set_level(ffmpeg.AV_LOG_ERROR);

            _ffmpegInitialized = true;
        }

        public event Action<StreamStatus>? OnStreamStatusChanged;
        public event Action<string>? OnIceCandidateGenerated;
        public event Action<string>? OnAnswerCreated;
        public Action<RawImage>? OnDecodedRawFrame { get; set; }
        public Action? OnSceneCut { get; set; }
        public event Action<string>? OnLog;
        public event Action<string>? OnError;

        /// <summary>
        /// Raised when the media path appears genuinely stuck (user injected input
        /// but no RTP arrived within the grace window). The host should fully
        /// restart the stream to rebuild the WebRTC transport. Throttled internally
        /// by <see cref="FreezeRecoveryCooldownMs"/>.
        /// </summary>
        public event Action? OnStreamRecoveryNeeded;

        /// <summary>
        /// Called by the control path whenever a user input event is sent to the
        /// device, so the freeze watchdog can correlate input with video updates.
        /// </summary>
        public void NotifyInputSent() => Interlocked.Exchange(ref _lastInputAtTicks, Stopwatch.GetTimestamp());

        public bool IsPeerInitialized => _peerConnection != null;
        public string? CurrentSessionId => _currentSessionId;
        public RTCPeerConnectionState? ConnectionState => _peerConnection?.connectionState;
        public bool ControlDataChannelReady =>
            _controlChannel?.readyState == RTCDataChannelState.open;

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
                if (!string.IsNullOrEmpty(_ffmpegLoadDiag))
                    OnLog?.Invoke($"[WebRTC] FFmpeg native libraries {_ffmpegLoadDiag}");

                if (_peerConnection != null)
                    ClosePeer();

                _currentSessionId = sessionId;
                _hasRemoteDescription = false;
                _controlChannel = null;
                _pendingCandidates.Clear();
                _encodedFrameCount = 0;
                _h264ParamsReady = false;
                _idrSinceReset = false;
                _codecReadyLogged = false;
                _loggedSps = false;
                _loggedPps = false;
                _loggedNonPrimaryVideoStream = false;
                _unifiedH264Framer = null;
                _videoRtpPacketsReceived = 0;
                _dropDecodedUntilIdr = false;
                _acceptNextDecodedFrame = false;
                _sceneCutActivatedTicks = 0;
                _skippedPreParamFrames = 0;
                _acceptedIdrCount = 0;
                _iceCandidateLogCount = 0;
                _concealmentAtLastPresent = 0;
                lock (_paramSetLock)
                {
                    _cachedSpsNal = null;
                    _cachedPpsNal = null;
                }

                // Create (or reuse) the scene-cut watchdog timer — armed
                // only when NotifySceneCut() is called, disarmed in ClosePeer().
                _sceneCutWatchdog ??= new Timer(OnSceneCutWatchdog, null,
                    Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);

                // Reset A/B diagnostics for this session and start the periodic
                // stats reporter (every 5 s, to both providers' log lines for
                // side-by-side comparison).
                _diagLogger.ResetForSession();
                _diagLogger.Sink = msg => OnLog?.Invoke(msg);
                _firstDecodedFrameTicks = 0;
                _statsSessionStartTicks = Stopwatch.GetTimestamp();
                _statsTimer?.Dispose();
                _statsTimer = new Timer(_ => EmitAbStats(), null,
                    dueTime: TimeSpan.FromSeconds(5),
                    period: TimeSpan.FromSeconds(5));

                // No STUN servers: this is local-network streaming and STUN
                // requires internet round-trips that add 3–5 s of startup
                // latency while waiting for STUN responses (or their timeouts).
                // Host candidates are sufficient on a LAN.
                var config = new RTCConfiguration
                {
                    iceServers = new List<RTCIceServer>(),
                    X_UseRtpFeedbackProfile = true
                };

                _peerConnection = new RTCPeerConnection(config);
                SetupPeerConnectionEvents();

                // FFmpegVideoEndPoint is required for correct H.264 payload-type
                // negotiation (server uses dynamic PT e.g. 97).
                _videoEndPoint = new FFmpegVideoEndPoint();
                _videoEndPoint.RestrictFormats(IsH264Format);
                _videoEndPoint.OnVideoSinkDecodedSampleFaster += HandleDecodedVideoFrame;

                var sinkFormats = FilterH264Formats(_videoEndPoint.GetVideoSinkFormats());
                if (sinkFormats.Count == 0)
                {
                    OnError?.Invoke("[WebRTC] No H.264 decoder formats available in FFmpeg");
                    return false;
                }

                OnLog?.Invoke($"[WebRTC] Decoder formats: {string.Join(", ", sinkFormats.Select(f => $"{f.FormatName} PT={f.FormatID}"))}");

                var videoTrack = new MediaStreamTrack(sinkFormats, MediaStreamStatusEnum.RecvOnly);
                _peerConnection.addTrack(videoTrack);

                _peerConnection.OnVideoFormatsNegotiated += formats =>
                {
                    if (formats == null || formats.Count == 0)
                        return;
                    var picked = PickH264Format(formats);
                    ApplyDecoderFormat(picked, "negotiated");
                    OnLog?.Invoke($"[WebRTC] Negotiated H.264 PT={picked.FormatID}");
                };

                OnLog?.Invoke("[WebRTC] Peer ready — SIPSorcery depacketization + FFmpeg decode");

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

        /// <summary>Send a control event over the WebRTC DataChannel when open.</summary>
        public bool TrySendControlViaDataChannel(object controlEvent)
        {
            if (_controlChannel?.readyState != RTCDataChannelState.open)
                return false;

            try
            {
                var json = JsonSerializer.Serialize(new { @event = controlEvent });
                _controlChannel.send(json);
                return true;
            }
            catch (Exception ex)
            {
                OnLog?.Invoke($"[WebRTC] DataChannel send failed: {ex.Message}");
                return false;
            }
        }

        private void WireControlDataChannel(RTCDataChannel channel)
        {
            if (!string.Equals(channel.label, "control", StringComparison.Ordinal))
                return;

            _controlChannel = channel;
            channel.onopen += () => OnLog?.Invoke("[WebRTC] Control DataChannel OPEN");
            channel.onclose += () =>
            {
                OnLog?.Invoke("[WebRTC] Control DataChannel CLOSED");
                if (ReferenceEquals(_controlChannel, channel))
                    _controlChannel = null;
            };
        }

        private int _concealmentAtLastPresent;

        private void HandleDecodedVideoFrame(RawImage rawImage)
        {
            if (rawImage == null || rawImage.Width <= 0 || rawImage.Height <= 0)
                return;

            var conceal = _diagLogger.ConcealmentFrames;
            if (conceal > _concealmentAtLastPresent)
            {
                _concealmentAtLastPresent = conceal;
                return;
            }

            if (_dropDecodedUntilIdr)
            {
                if (!_acceptNextDecodedFrame)
                    return;
                _acceptNextDecodedFrame = false;
                _dropDecodedUntilIdr = false;
            }

            var n = Interlocked.Increment(ref _decodePublished);

            // One-shot: record the tick at which the first decoded frame arrived.
            if (n == 1 && _statsSessionStartTicks > 0)
            {
                var ticks = Stopwatch.GetTimestamp();
                if (Interlocked.CompareExchange(ref _firstDecodedFrameTicks, ticks, 0) == 0)
                {
                    var firstEncodedMs = _firstFrameTicks > 0
                        ? (int)((_firstFrameTicks - _statsSessionStartTicks) / (double)Stopwatch.Frequency * 1000)
                        : -1;
                    var firstDecodedMs = (int)((ticks - _statsSessionStartTicks) / (double)Stopwatch.Frequency * 1000);
                    OnLog?.Invoke($"[WebRTC] First decoded frame — " +
                        $"firstEncodedMs={firstEncodedMs} firstDecodedMs={firstDecodedMs} " +
                        $"resolution={rawImage.Width}x{rawImage.Height}");
                }
            }

            OnDecodedRawFrame?.Invoke(rawImage);
        }

        /// <summary>
        /// Emits a single-line A/B comparison stats snapshot to <see cref="OnLog"/>.
        /// Fired by the stats timer every 5 s and once at session close.
        /// Parse with: grep "\[AB_STATS\]" server.log | column -t
        /// </summary>
        private void EmitAbStats()
        {
            try
            {
                var now = Stopwatch.GetTimestamp();
                var elapsedSec = _statsSessionStartTicks > 0
                    ? (now - _statsSessionStartTicks) / (double)Stopwatch.Frequency
                    : 0;

                var encoded  = _encodedFrameCount;
                var decoded  = _decodePublished;
                // Measure FPS from the first decoded frame onwards so the
                // ~7 s startup window (no video) does not drag the number down.
                var streamingSec = _firstDecodedFrameTicks > 0
                    ? (now - _firstDecodedFrameTicks) / (double)Stopwatch.Frequency
                    : 0;
                var decodedFps = streamingSec > 1 ? Math.Round(decoded / streamingSec, 1) : 0.0;

                var firstEncodedMs = _firstFrameTicks > 0 && _statsSessionStartTicks > 0
                    ? (int)((_firstFrameTicks - _statsSessionStartTicks) / (double)Stopwatch.Frequency * 1000)
                    : -1;
                var firstDecodedMs = _firstDecodedFrameTicks > 0 && _statsSessionStartTicks > 0
                    ? (int)((_firstDecodedFrameTicks - _statsSessionStartTicks) / (double)Stopwatch.Frequency * 1000)
                    : -1;

                var proc = Process.GetCurrentProcess();
                proc.Refresh();
                var memMB = proc.WorkingSet64 / 1024 / 1024;

                OnLog?.Invoke(
                    $"[AB_STATS] elapsed={elapsedSec:F1}s " +
                    $"encoded={encoded} decoded={decoded} " +
                    $"decodedFps={decodedFps:F1} " +
                    $"acceptedIdr={_acceptedIdrCount} " +
                    $"skippedPreGate={_skippedPreParamFrames} " +
                    $"concealmentFrames={_diagLogger.ConcealmentFrames} " +
                    $"ffmpegErrors={_diagLogger.FfmpegErrors} " +
                    $"ffmpegWarnings={_diagLogger.FfmpegWarnings} " +
                    $"videoRtp={_videoRtpPacketsReceived} " +
                    $"firstEncodedMs={firstEncodedMs} " +
                    $"firstDecodedMs={firstDecodedMs} " +
                    $"memMB={memMB}");
            }
            catch { /* stats must never crash the app */ }
        }

        private void SetupPeerConnectionEvents()
        {
            if (_peerConnection == null)
                return;

            _onIceCandidateHandler = candidate =>
            {
                if (candidate == null || string.IsNullOrEmpty(candidate.candidate))
                    return;

                if (Interlocked.Increment(ref _iceCandidateLogCount) <= 2)
                {
                    OnLog?.Invoke($"[WebRTC] Local ICE candidate: {candidate.candidate[..Math.Min(50, candidate.candidate.Length)]}...");
                }
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

            _peerConnection.ondatachannel += dcEvt =>
            {
                if (dcEvt != null)
                    WireControlDataChannel(dcEvt);
            };

            // ── RTP delivery: direct path (jitter buffer intentionally disabled) ──
            //
            // SIPSorcery's RTCPeerConnection exposes two paths for received video:
            //
            //   A) OnVideoFrameReceived (used here):
            //      RTP → SIPSorcery FU-A reassembly → full encoded access unit →
            //      our CanFeedPayload gate → FFmpeg decode.
            //      Delivers every reassembled AU synchronously on the network thread.
            //      No jitter buffer depth, no MaxAge drops, zero added latency.
            //
            //   B) Automatic media endpoint pipe (would use the JB):
            //      RTP → SIPSorcery jitter buffer (50–200 ms depth) → FU-A reassembly →
            //      FFmpeg video endpoint → decoded frame.
            //      Reorders out-of-sequence UDP packets before decoding.
            //
            // WHY WE USE PATH A (AND NOT B) FOR THIS SYSTEM
            // ──────────────────────────────────────────────
            // • This is a local-network or loopback stream. UDP packet reordering
            //   probability over LAN/loopback is effectively zero; a jitter buffer
            //   adds 50–200 ms latency without fixing anything.
            //
            // • The "concealing N DC, AC, MV errors" log messages that motivated
            //   the jitter buffer request come from the *encoder*, not the network:
            //   they appear when FFmpeg or the capture pipeline emit partial NAL units.
            //   AnnexBIdrGate gates P-frames until a valid SPS+PPS+IDR sequence.
            //
            // • The CanFeedPayload / ExpandPayloadForDecoder gate (Path A) provides
            //   the same correctness guarantee as a JB: no P-frame reaches FFmpeg
            //   before a valid SPS+PPS+IDR sequence, eliminating decoder state
            //   corruption regardless of network order.
            //
            // HOW TO ENABLE PATH B (JB) FOR WAN DEPLOYMENT
            // ─────────────────────────────────────────────
            // Remove the OnVideoFrameReceived subscription below, remove the manual
            // _videoEndPoint.GotVideoFrame() call, and let SIPSorcery wire the
            // media endpoint automatically (addTrack sets up the pipe).  Configure:
            //
            //   // (on the RTCSession inside the peer connection)
            //   _peerConnection.VideoRtpChannel.UseRtpJitterBuffer = true;
            //
            // Then handle "no frame!" FFmpeg warnings by adding a SPS+PPS injector
            // in the FFmpegVideoEndPoint.
            //
            // Per-stream SIPSorcery depacketizers can split STAP-A (stream 0) from
            // IDR FU-A chains (stream 1) on the first connect when a local RecvOnly
            // track is added before the remote offer lands.  Reassemble ALL video
            // RTP through one H.264 framer so every access unit is delivered.
            _peerConnection.OnRtpPacketReceivedByIndex += HandleIncomingRtpPacket;
        }

        private void HandleIncomingRtpPacket(
            int streamIndex,
            IPEndPoint remoteEndPoint,
            SDPMediaTypesEnum mediaType,
            RTPPacket rtpPacket)
        {
            if (mediaType != SDPMediaTypesEnum.video || rtpPacket?.Header == null)
                return;

            var pt = rtpPacket.Header.PayloadType;
            if (_activeVideoFormat.HasValue && pt != _activeVideoFormat.Value.FormatID)
                return;

            var rtpCount = Interlocked.Increment(ref _videoRtpPacketsReceived);
            Interlocked.Exchange(ref _lastRtpAtTicks, Stopwatch.GetTimestamp());
            if (rtpCount == 1 || rtpCount == 50 || rtpCount % 300 == 0)
            {
                OnLog?.Invoke(
                    $"[WebRTC] Video RTP #{rtpCount} stream={streamIndex} pt={pt} " +
                    $"seq={rtpPacket.Header.SequenceNumber} marker={rtpPacket.Header.MarkerBit}");
            }

            _unifiedH264Framer ??= new RtpVideoFramer(VideoCodecsEnum.H264, 1048576);

            byte[]? frame;
            try
            {
                frame = _unifiedH264Framer.GotRtpPacket(rtpPacket);
            }
            catch (Exception ex)
            {
                if (rtpCount <= 5 || rtpCount % 300 == 0)
                    OnLog?.Invoke($"[WebRTC] RTP depacketize error: {ex.Message}");
                return;
            }

            if (frame == null || frame.Length == 0)
                return;

            var format = _activeVideoFormat ?? new VideoFormat(VideoCodecsEnum.H264, pt);
            HandleIncomingVideoFrame(streamIndex, remoteEndPoint, rtpPacket.Header.Timestamp, frame, format);
        }

        private void HandleIncomingVideoFrame(
            int streamIndex,
            IPEndPoint remoteEndPoint,
            uint timestamp,
            byte[] payload,
            VideoFormat format)
        {
            if (payload == null || payload.Length == 0)
                return;

            if (!IsH264Format(format))
                return;

            if (streamIndex != 0 && !_loggedNonPrimaryVideoStream)
            {
                _loggedNonPrimaryVideoStream = true;
                OnLog?.Invoke(
                    $"[WebRTC] Video on stream index {streamIndex} " +
                    $"(OnVideoFrameReceived only forwards index 0 — handling all indices)");
            }

            var n = Interlocked.Increment(ref _encodedFrameCount);
            if (n == 1)
            {
                CancelMediaWatch();
                _firstFrameTicks = Stopwatch.GetTimestamp();
                OnLog?.Invoke(
                    $"[WebRTC] First encoded frame from unified RTP framer " +
                    $"(stream={streamIndex}, {payload.Length} bytes)");
            }
            else if (n == 5 || n == 30 || n == 60 || n == 120 || n % 300 == 0)
            {
                OnLog?.Invoke(
                    $"[WebRTC] Encoded #{n} stream={streamIndex} bytes={payload.Length} " +
                    $"decoded={_decodePublished} acceptedIdr={_acceptedIdrCount} " +
                    $"droppedPreGate={_skippedPreParamFrames} sps={_h264ParamsReady} " +
                    $"idr={_idrSinceReset} codecReady={CodecReady}");
            }

            LogPayloadShape(payload, n);
            LogNalDiagnostics(payload, n);

            UpdateParamSetFlags(payload);

            foreach (var feed in ExpandPayloadForDecoder(payload))
            {
                if (!CanFeedPayload(feed))
                {
                    Interlocked.Increment(ref _skippedPreParamFrames);
                    continue;
                }

                // Hold _decodeLock across the native decode so ClosePeer cannot
                // dispose the FFmpeg endpoint mid-frame (use-after-free → SIGSEGV).
                lock (_decodeLock)
                {
                    if (_videoEndPoint == null)
                        return;

                    if (_activeVideoFormat == null || _activeVideoFormat.Value.FormatID != format.FormatID)
                        ApplyDecoderFormat(format, "frame");

                    try
                    {
                        _videoEndPoint.GotVideoFrame(remoteEndPoint, timestamp, feed, format);
                    }
                    catch (Exception ex)
                    {
                        if (n <= 5 || n % 60 == 0)
                            OnLog?.Invoke($"[WebRTC] GotVideoFrame error: {ex.Message}");
                    }
                }
            }
        }

        private void LogNalDiagnostics(byte[] payload, int frameNumber)
        {
            if (payload == null || payload.Length == 0) return;

            bool sample = frameNumber <= 20 || frameNumber % 120 == 0;
            if (!sample) return;

            var types = new List<int>();
            foreach (var nal in ExtractAllNals(payload))
            {
                if (nal.Length == 0) continue;
                types.Add(nal[0] & 0x1f);
            }

            AnalyzeH264Payload(payload, out var hasSps, out var hasPps, out var hasIdr, out var hasP);
            OnLog?.Invoke(
                $"[H264-RX] frame=#{frameNumber} bytes={payload.Length} " +
                $"nals=[{string.Join(",", types)}] " +
                $"sps={hasSps} pps={hasPps} idr={hasIdr} p={hasP} " +
                $"gateReady={CodecReady} acceptedIdr={_acceptedIdrCount}");
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

        /// <summary>
        /// Continuous, interaction-correlated freeze watchdog. Fires
        /// <see cref="OnStreamRecoveryNeeded"/> when the user has injected input but
        /// no RTP has arrived for <see cref="FreezeGraceMs"/> afterwards. Never fires
        /// on an idle screen (no input → no trigger) and is throttled to at most one
        /// recovery per <see cref="FreezeRecoveryCooldownMs"/>.
        /// </summary>
        private void StartFreezeWatch()
        {
            _freezeWatchCts?.Cancel();
            _freezeWatchCts?.Dispose();
            _freezeWatchCts = new CancellationTokenSource();
            var token = _freezeWatchCts.Token;

            _ = Task.Run(async () =>
            {
                while (!token.IsCancellationRequested)
                {
                    try
                    {
                        await Task.Delay(1000, token);
                    }
                    catch (TaskCanceledException)
                    {
                        return;
                    }

                    if (token.IsCancellationRequested)
                        return;

                    // Only meaningful once media has actually flowed at least once.
                    if (Volatile.Read(ref _videoRtpPacketsReceived) == 0)
                        continue;

                    var now = Stopwatch.GetTimestamp();
                    var lastInput = Interlocked.Read(ref _lastInputAtTicks);
                    var lastRtp = Interlocked.Read(ref _lastRtpAtTicks);
                    var lastRecovery = Interlocked.Read(ref _lastRecoveryAtTicks);

                    if (lastInput == 0)
                        continue;

                    // Input must be the most recent event AND old enough that any
                    // resulting frame should already have arrived.
                    bool inputAfterFrame = lastInput > lastRtp;
                    double inputIdleMs = (now - lastInput) * 1000.0 / Stopwatch.Frequency;
                    double sinceRecoveryMs = lastRecovery == 0
                        ? double.MaxValue
                        : (now - lastRecovery) * 1000.0 / Stopwatch.Frequency;

                    if (inputAfterFrame &&
                        inputIdleMs > FreezeGraceMs &&
                        sinceRecoveryMs > FreezeRecoveryCooldownMs)
                    {
                        Interlocked.Exchange(ref _lastRecoveryAtTicks, now);
                        OnLog?.Invoke(
                            $"[WebRTC] Media path stuck — input sent but no RTP for {inputIdleMs / 1000.0:F1}s. " +
                            "Requesting stream restart.");
                        try { OnStreamRecoveryNeeded?.Invoke(); }
                        catch { }
                    }
                }
            }, token);
        }

        private void CancelFreezeWatch()
        {
            _freezeWatchCts?.Cancel();
        }

        private double MediaWatchElapsedSeconds() =>
            _mediaWatchStartedTicks == 0
                ? 0
                : (Stopwatch.GetTimestamp() - _mediaWatchStartedTicks) / (double)Stopwatch.Frequency;

        public async Task HandleOfferAsync(string sdpOffer)
        {
            await _offerNegotiationLock.WaitAsync();
            try
            {
                if (_peerConnection == null)
                {
                    if (!await InitializePeerAsync(_currentSessionId ?? "default"))
                    {
                        OnError?.Invoke("[WebRTC] Failed to initialize peer for offer");
                        return;
                    }
                }

                if (_hasRemoteDescription)
                {
                    OnLog?.Invoke("[WebRTC] Offer already applied — ignoring duplicate");
                    return;
                }

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
                    var hint = result switch
                    {
                        SetDescriptionResultEnum.VideoIncompatible => " Server SDP must offer H.264.",
                        SetDescriptionResultEnum.NoMatchingMediaType => " Local recv track missing or incompatible with offer.",
                        _ => string.Empty
                    };
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
                StartFreezeWatch();
                OnLog?.Invoke($"[WebRTC] Answer sent — waiting for media (elapsed {MediaWatchElapsedSeconds():F1}s)");
            }
            catch (Exception ex)
            {
                OnError?.Invoke($"[WebRTC] Failed to handle offer: {ex.Message}");
                OnStreamStatusChanged?.Invoke(StreamStatus.Error);
            }
            finally
            {
                _offerNegotiationLock.Release();
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
            if (_acceptedIdrCount == 0 && _decodePublished == 0)
                return;

            // Flush the render slot only. Do not gate FFmpeg decode here — the
            // scene_cut WebSocket hint can arrive after the matching IDR RTP and
            // would drop the keyframe, freezing the mirror until reconnect.
            try { OnSceneCut?.Invoke(); }
            catch { /* render-side flush must never fault the WebRTC path */ }
            OnLog?.Invoke("[WebRTC] Scene cut hint — render slot flushed");
        }

        private void OnSceneCutWatchdog(object? _)
        {
            if (!_dropDecodedUntilIdr) return;

            var staleSec = (Stopwatch.GetTimestamp() - _sceneCutActivatedTicks)
                         / (double)Stopwatch.Frequency;
            if (staleSec < SceneCutWatchdogSec) return;

            _dropDecodedUntilIdr = false;
            _acceptNextDecodedFrame = false;
            OnLog?.Invoke(
                $"[WebRTC] Scene-cut watchdog: reopening decode after {staleSec:F1}s without IDR");
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

            // Emit a final A/B stats snapshot before teardown so there is always
            // a complete record even if the session ends mid-timer-interval.
            EmitAbStats();
            _statsTimer?.Dispose();
            _statsTimer = null;
            _diagLogger.Sink = null;
            _firstDecodedFrameTicks = 0;
            _statsSessionStartTicks = 0;

            // Order matters: stop inbound RTP delivery BEFORE disposing the FFmpeg
            // decoder. Otherwise a packet already in flight on the RTP receive
            // thread can call GotVideoFrame() on a freed native decoder context
            // and segfault the process (observed as exit code 139 on destroy).
            if (_peerConnection != null)
            {
                try { _peerConnection.OnRtpPacketReceivedByIndex -= HandleIncomingRtpPacket; }
                catch { }
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

            // Dispose the decoder under the same lock the decode path holds, so a
            // concurrent GotVideoFrame() finishes before the native context is freed.
            lock (_decodeLock)
            {
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
            }

            _controlChannel = null;

            CancelMediaWatch();

            // Disarm the scene-cut watchdog so it cannot fire during teardown
            // and re-open the gate after _dropDecodedUntilIdr is cleared below.
            _sceneCutWatchdog?.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);

            _h264ParamsReady = false;
            _idrSinceReset = false;
            _codecReadyLogged = false;
            _loggedSps = false;
            _loggedPps = false;
            _loggedNonPrimaryVideoStream = false;
            _unifiedH264Framer = null;
            _videoRtpPacketsReceived = 0;
            _dropDecodedUntilIdr = false;
            _acceptNextDecodedFrame = false;
            _sceneCutActivatedTicks = 0;
            lock (_paramSetLock)
            {
                _cachedSpsNal = null;
                _cachedPpsNal = null;
            }
            _mediaWatchCts?.Dispose();
            _mediaWatchCts = null;
            _mediaWatchStartedTicks = 0;
            CancelFreezeWatch();
            _freezeWatchCts?.Dispose();
            _freezeWatchCts = null;
            _lastRtpAtTicks = 0;
            _lastInputAtTicks = 0;
            _lastRecoveryAtTicks = 0;
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

        public void Dispose()
        {
            if (_disposed)
                return;
            _disposed = true;
            ClosePeer();
            _sceneCutWatchdog?.Dispose();
            _sceneCutWatchdog = null;
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
