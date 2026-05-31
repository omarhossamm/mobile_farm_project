using System;
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
