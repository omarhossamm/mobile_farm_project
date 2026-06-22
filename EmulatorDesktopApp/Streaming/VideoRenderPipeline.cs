using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using Avalonia.Threading;
using EmulatorDesktopApp.Services;
using EmulatorDesktopApp.ViewModels;
using SIPSorceryMedia.Abstractions;

namespace EmulatorDesktopApp.Streaming
{
    /// <summary>
    /// Latest-frame-only render path: decode slot → worker convert &amp; upload →
    /// coalesced, rate-limited UI bitmap swap.
    ///
    /// THREADING MODEL
    /// ───────────────
    /// • <see cref="SubmitDecoded"/> / <see cref="OnSceneCut"/> run on the
    ///   SIPSorcery RTP receive thread. They only touch the slot + signal —
    ///   they never block on locks held by the worker or the UI.
    /// • Worker thread (this file) drains the slot, picks an inactive
    ///   <see cref="WriteableBitmap"/> from a 4-slot strict rotation and
    ///   converts the decoded pixels straight into that bitmap's locked
    ///   framebuffer. No intermediate scratch BGRA buffer is allocated or
    ///   copied.
    /// • UI thread receives at most <see cref="MaxRenderFps"/> coalesced
    ///   <see cref="Dispatcher.UIThread"/> posts per second (default 30 FPS).
    ///   Between posts a <see cref="Task.Delay"/> re-schedules the next pump
    ///   without pinning the UI thread in a tight loop. It performs a single
    ///   reference assignment (<c>Image.Source = bitmap</c>) — no pixel work,
    ///   no locking.
    ///
    /// 4-BITMAP STRICT ROTATION
    /// ────────────────────────
    /// The worker writes to bitmaps in a fixed 0→1→2→3→0 order and never
    /// makes decisions based on UI state. With 4 bitmaps and at most 2 of
    /// them in flight on the UI side at any moment (the one currently bound
    /// to <c>Image.Source</c> plus the previously-bound one that may still
    /// be in the compositor's pending render pass), the bitmap the worker is
    /// about to overwrite has definitely cycled out of the GPU pipeline.
    /// This makes the worker oblivious to UI bookkeeping and removes every
    /// shared lock between the worker and the UI thread.
    ///
    /// RENDER FPS CAP
    /// ──────────────
    /// When the FFmpeg decoder produces frames faster than the cap (e.g. the
    /// server sends at 60 FPS but the display runs at 60 Hz with an Avalonia
    /// compositor overhead of ~4 ms/frame), the dispatcher queue would fill up
    /// causing input-event latency and visible jitter.  The cap:
    ///   1. Checks wall-clock time in <see cref="RunUiPump"/>.
    ///   2. If a newer frame exists but the minimum inter-present interval has
    ///      not elapsed, schedules a <see cref="Task.Delay"/> on the thread
    ///      pool that fires <see cref="RequestUiPresent"/> after the remaining
    ///      time — coalescing with any frame the worker produces in the interim.
        ///   At 60 FPS the UI dispatcher sees at most one post every ~16 ms,
    ///      leaving the thread free for input events, animations, and chrome.
    /// </summary>
    public sealed class VideoRenderPipeline : IDisposable
    {
        private const int BitmapPoolSize = 4;

        /// <summary>
        /// Maximum UI frames-per-second. Reduce to 25 on lower-end hardware;
        /// raise to 60 only if your display and compositor can sustain it
        /// without introducing new dispatcher contention.
        /// Override at runtime with the RENDER_TARGET_FPS environment variable.
        /// </summary>
        public static readonly int MaxRenderFps = ResolveMaxRenderFps();

        private static readonly long MinRenderIntervalTicks =
            Stopwatch.Frequency / Math.Max(1, MaxRenderFps);

        private static int ResolveMaxRenderFps()
        {
            if (int.TryParse(System.Environment.GetEnvironmentVariable("RENDER_TARGET_FPS"),
                out var v) && v > 0 && v <= 120)
                return v;
            return 60;
        }

        private readonly LatestFrameSlot _slot = new();
        private readonly Action<string> _log;
        private readonly AutoResetEvent _frameSignal = new(false);
        private readonly WriteableBitmap?[] _bitmaps = new WriteableBitmap?[BitmapPoolSize];

        private StreamWindowViewModel? _target;

        // Most-recently-produced bitmap awaiting UI binding. Volatile because
        // the worker writes and the UI thread reads. Latest-wins: the worker
        // may overwrite this reference before the UI has consumed it (the
        // overwritten bitmap was never bound, so it's safe to discard).
        private volatile WriteableBitmap? _pendingFrontBitmap;
        private int _writeIndex;  // worker-only
        private int _bitmapWidth;
        private int _bitmapHeight;

        private CancellationTokenSource? _workerCts;
        private Task? _workerTask;

        private int _latestGenForUi;
        private int _uiPumpScheduled;
        private int _lastUiPresentedGeneration;

        // Ticks of the last successful UI present — written only on the UI
        // thread (inside RunUiPump), read only on the UI thread, so no
        // Interlocked or volatile required.
        private long _lastPresentTicks;

        private int _convertedCount;
        private int _presentedCount;
        private bool _disposed;

        public VideoRenderPipeline(Action<string> log) => _log = log;

        public long SkippedBeforeRender => _slot.ReplacedCount;

        /// <summary>
        /// Drop stale decoded frames after an IDR (screen rotation / app switch).
        /// </summary>
        public void OnSceneCut()
        {
            if (_target?.IsShuttingDown == true)
                return;

            // Drop the not-yet-converted decoded frame queued before the cut so we
            // don't paint a pre-discontinuity image. Do NOT blank
            // _pendingFrontBitmap: clearing it left the screen black until the next
            // frame was converted, producing a visible flash on every scene cut.
            // Keeping the last good frame on screen until the post-cut frame is
            // ready is seamless, and the server now only signals scene_cut on a
            // genuine discontinuity (SPS/resolution change), not routine keyframes.
            _slot.Clear();
            Interlocked.Increment(ref _latestGenForUi);
            _frameSignal.Set();
        }

        public void SubmitDecoded(RawImage rawImage)
        {
            if (_disposed || rawImage == null || rawImage.Width <= 0 || rawImage.Height <= 0)
                return;

            var frame = VideoFrameInfo.FromRawImage(rawImage);
            if (frame.Data.Length == 0)
            {
                frame.Release();
                return;
            }

            _slot.Set(frame);
            _frameSignal.Set();
        }

        public void AttachTarget(StreamWindowViewModel? target) => _target = target;

        public void Start()
        {
            StopWorker();
            _slot.Clear();
            _convertedCount = 0;
            _presentedCount = 0;
            _lastUiPresentedGeneration = 0;
            _lastPresentTicks = 0;
            Interlocked.Exchange(ref _latestGenForUi, 0);
            Interlocked.Exchange(ref _uiPumpScheduled, 0);

            _workerCts = new CancellationTokenSource();
            _workerTask = Task.Run(() => WorkerLoop(_workerCts.Token));
        }

        public void Stop()
        {
            StopAsync().GetAwaiter().GetResult();
        }

        public async Task StopAsync()
        {
            await StopWorkerAsync();
            _slot.Clear();
            Interlocked.Exchange(ref _uiPumpScheduled, 0);
        }

        public void ClearBitmap()
        {
            ReleaseBitmapPool();
            _pendingFrontBitmap = null;
            _writeIndex = 0;
            _bitmapWidth = 0;
            _bitmapHeight = 0;
        }

        private void ReleaseBitmapPool()
        {
            for (int i = 0; i < _bitmaps.Length; i++)
            {
                _bitmaps[i]?.Dispose();
                _bitmaps[i] = null;
            }
        }

        private void EnsureBitmapPool(int width, int height)
        {
            bool needsAlloc = _bitmapWidth != width || _bitmapHeight != height;
            for (int i = 0; i < _bitmaps.Length && !needsAlloc; i++)
                if (_bitmaps[i] == null) { needsAlloc = true; break; }

            if (!needsAlloc) return;

            ReleaseBitmapPool();

            for (int i = 0; i < _bitmaps.Length; i++)
            {
                _bitmaps[i] = new WriteableBitmap(
                    new PixelSize(width, height),
                    new Vector(96, 96),
                    PixelFormat.Bgra8888,
                    AlphaFormat.Premul);
            }

            _bitmapWidth = width;
            _bitmapHeight = height;
            _pendingFrontBitmap = null;
            _writeIndex = 0;
        }

        /// <summary>
        /// Strict rotation — the worker always advances by one slot, never
        /// branches on UI state. With a 4-slot pool and a UI consumer that
        /// holds at most 2 slots (currently bound + last-frame compositor
        /// reference), the next slot is guaranteed to be out of the GPU
        /// pipeline.
        /// </summary>
        private WriteableBitmap PickWritableBitmap()
        {
            var bm = _bitmaps[_writeIndex]!;
            _writeIndex = (_writeIndex + 1) % BitmapPoolSize;
            return bm;
        }

        private void StopWorker()
        {
            StopWorkerAsync().GetAwaiter().GetResult();
        }

        private async Task StopWorkerAsync()
        {
            if (_workerCts == null)
                return;

            _frameSignal.Set();
            _workerCts.Cancel();

            var task = _workerTask;
            var cts = _workerCts;
            _workerCts = null;
            _workerTask = null;

            if (task != null)
            {
                try { await task.WaitAsync(TimeSpan.FromSeconds(2)); }
                catch { /* ignore on shutdown */ }
            }

            cts.Dispose();
        }

        private void WorkerLoop(CancellationToken cancel)
        {
            Thread.CurrentThread.Priority = ThreadPriority.AboveNormal;

            while (!cancel.IsCancellationRequested)
            {
                _frameSignal.WaitOne(100);
                if (cancel.IsCancellationRequested) break;

                // Process bursts without sleeping — always convert only the newest in each batch.
                while (!cancel.IsCancellationRequested)
                {
                    var latest = DrainLatestFrame();
                    if (latest == null) break;

                    try
                    {
                        if (!ConvertAndPublish(latest)) continue;

                        Interlocked.Increment(ref _latestGenForUi);

                        int converted = Interlocked.Increment(ref _convertedCount);
                        if (converted == 1 || converted % 120 == 0)
                            _log($"[RENDER] Converted #{converted} (slot skips: {_slot.ReplacedCount})");

                        if (_target != null) RequestUiPresent();
                    }
                    finally
                    {
                        latest.Release();
                    }
                }
            }
        }

        /// <summary>Take all pending frames and keep only the newest.</summary>
        private VideoFrameInfo? DrainLatestFrame()
        {
            VideoFrameInfo? latest = null;
            while (_slot.TryTake(out var frame) && frame != null)
            {
                latest?.Release();
                latest = frame;
            }

            return latest;
        }

        /// <summary>
        /// Pick an inactive bitmap, lock it, convert the decoded frame directly
        /// into its framebuffer, then publish it as the next pending-front. All
        /// performed off the UI thread so the dispatcher remains free for input
        /// + window chrome handling.
        /// </summary>
        private bool ConvertAndPublish(VideoFrameInfo frame)
        {
            int width = frame.Width;
            int height = frame.Height;
            if (width <= 0 || height <= 0) return false;

            EnsureBitmapPool(width, height);
            var writeBitmap = PickWritableBitmap();

            string fmt = VideoFrameConverter.DetectFormat(
                frame.Data.Length, width, height, frame.Format, frame.Stride);

            bool ok;
            using (var locked = writeBitmap.Lock())
            {
                ok = fmt switch
                {
                    "BGRA32" => InvokeBgraCopy(frame, width, height, locked),
                    "BGR24"  => VideoFrameConverter.CopyBgr24ToLocked(
                                    frame.Data, width, height, frame.Stride, locked),
                    "RGB24"  => VideoFrameConverter.CopyRgb24ToLocked(
                                    frame.Data, width, height, frame.Stride, locked),
                    _ => false
                };
            }

            if (!ok) return false;

            _pendingFrontBitmap = writeBitmap;
            return true;
        }

        private static bool InvokeBgraCopy(VideoFrameInfo frame, int width, int height, ILockedFramebuffer locked)
        {
            VideoFrameConverter.CopyBgraToLocked(frame.Data, width, height, frame.Stride, locked);
            return true;
        }

        private void RequestUiPresent()
        {
            // CAS guarantees at most one outstanding post to the dispatcher.
            // Both the worker thread and the Task.Delay continuation call this;
            // whichever gets CAS first owns the post, the other is a no-op.
            if (Interlocked.CompareExchange(ref _uiPumpScheduled, 1, 0) != 0)
                return;

            Dispatcher.UIThread.Post(RunUiPump, DispatcherPriority.Send);
        }

        /// <summary>
        /// Runs on the Avalonia UI thread.  Presents the newest frame and
        /// re-schedules at most once per <see cref="MinRenderIntervalTicks"/>
        /// to keep the dispatcher free for input events.
        /// </summary>
        private void RunUiPump()
        {
            Interlocked.Exchange(ref _uiPumpScheduled, 0);
            if (_disposed || _target == null || _target.IsShuttingDown)
                return;

            int gen = Interlocked.CompareExchange(ref _latestGenForUi, 0, 0);
            if (gen > _lastUiPresentedGeneration)
            {
                // ── Render-rate cap ──────────────────────────────────────
                // Measure wall-clock time since the last present.  If we are
                // being called faster than MaxRenderFps, defer a re-post
                // instead of presenting immediately — this prevents the
                // dispatcher queue from filling at 60+ fps.
                var now = Stopwatch.GetTimestamp();
                var elapsed = now - _lastPresentTicks;

                if (_lastPresentTicks > 0 && elapsed < MinRenderIntervalTicks)
                {
                    // Too soon.  Schedule a deferred re-post via the thread
                    // pool — the delay keeps the UI thread idle (no spinning).
                    // Any frame the worker produces in the meantime is picked
                    // up by the next call to RunUiPump.
                    var remainingMs = (int)Math.Max(
                        1,
                        (MinRenderIntervalTicks - elapsed) * 1000 / Stopwatch.Frequency);

                    _ = Task.Delay(remainingMs).ContinueWith(
                        _ => RequestUiPresent(),
                        TaskScheduler.Default);
                    return;
                }

                PresentLatest(gen);
            }

            // If the worker produced more frames while we were presenting,
            // reschedule immediately (we already spent the inter-present
            // interval on the present above, so no additional delay needed).
            if (Interlocked.CompareExchange(ref _latestGenForUi, 0, 0) > gen)
                RequestUiPresent();
        }

        private void PresentLatest(int generation)
        {
            if (generation <= _lastUiPresentedGeneration) return;
            if (_target?.IsShuttingDown == true) return;

            // Volatile read of the bitmap the worker prepared. The worker
            // always overwrites this field on its next tick, so we don't
            // need to null it out here — the next produced frame replaces it.
            var bitmap = _pendingFrontBitmap;
            if (bitmap == null) return;

            try
            {
                _target!.UpdateFrame(bitmap);
                _target.NotifyFrameRendered();

                _lastUiPresentedGeneration = generation;
                _lastPresentTicks = Stopwatch.GetTimestamp();

                int presented = Interlocked.Increment(ref _presentedCount);
                if (presented == 1)
                    _log($"[RENDER] First present {_bitmapWidth}x{_bitmapHeight} cap={MaxRenderFps}fps");
                else if (presented % 120 == 0)
                    _log($"[RENDER] Presented #{presented} (slot skips: {SkippedBeforeRender})");
            }
            catch (Exception ex)
            {
                _log($"[RENDER ERROR] {ex.Message}");
            }
        }

        public void Dispose()
        {
            if (_disposed) return;

            _disposed = true;
            Stop();
            _frameSignal.Dispose();
            ReleaseBitmapPool();
        }
    }
}
