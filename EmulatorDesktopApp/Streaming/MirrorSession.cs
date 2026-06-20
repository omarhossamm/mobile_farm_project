using System;
using System.Threading.Tasks;
using EmulatorDesktopApp.Services;
using EmulatorDesktopApp.ViewModels;

namespace EmulatorDesktopApp.Streaming
{
    /// <summary>
    /// Low-latency mirror session: WebRTC → latest-frame render pipeline.
    /// </summary>
    public sealed class MirrorSession : IDisposable
    {
        private bool _disposed;

        public MirrorSession(Action<string> log)
        {
            Log = log;
            Render = new VideoRenderPipeline(log);
            WebRtc = new WebRTCClient();
        }

        public Action<string> Log { get; }

        public WebRTCClient WebRtc { get; }

        public VideoRenderPipeline Render { get; }

        public CoordinateMapper Coordinates { get; } = new();

        public StreamMeta? StreamMeta { get; private set; }

        public void ResetForNewStream()
        {
            StreamMeta = null;
            Coordinates.Apply(null);
            Render.ClearBitmap();
            Render.OnSceneCut();
        }

        public void ApplyStreamMeta(StreamMeta? meta)
        {
            StreamMeta = meta;
            Coordinates.Apply(meta);
        }

        public void UpdateStreamDimensions(int streamW, int streamH)
        {
            if (streamW <= 0 || streamH <= 0)
                return;
            if (StreamMeta != null &&
                StreamMeta.StreamWidth == streamW &&
                StreamMeta.StreamHeight == streamH)
                return;

            var meta = StreamMeta?.WithStreamSize(streamW, streamH)
                ?? new StreamMeta
                {
                    Platform = StreamMeta?.Platform ?? "android",
                    StreamWidth = streamW,
                    StreamHeight = streamH
                };
            ApplyStreamMeta(meta);
            Log($"[STREAM] Viewport updated stream={streamW}x{streamH}");
        }

        public void AttachStreamWindow(StreamWindowViewModel viewModel)
        {
            Render.AttachTarget(viewModel);
            Render.Start();
        }

        public void DetachStreamWindow()
        {
            Render.Stop();
            Render.AttachTarget(null);
            Render.ClearBitmap();
        }

        public async Task DetachStreamWindowAsync()
        {
            await Render.StopAsync();
            Render.AttachTarget(null);
            Render.ClearBitmap();
        }

        public void Dispose()
        {
            if (_disposed)
                return;

            _disposed = true;
            WebRtc.OnDecodedRawFrame = null;
            DetachStreamWindow();
            Render.Dispose();
            WebRtc.Dispose();
        }
    }
}
