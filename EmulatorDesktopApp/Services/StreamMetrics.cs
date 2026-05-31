using System;

namespace EmulatorDesktopApp.Services
{
    /// <summary>
    /// Rolling FPS and drop counters for stream debug overlay.
    /// </summary>
    public sealed class StreamMetrics
    {
        private int _decodeCount;
        private int _renderCount;
        private int _lastDecodeCount;
        private int _lastRenderCount;
        private DateTime _lastSample = DateTime.UtcNow;

        public int QueueDropped { get; set; }

        public void RecordDecoded() => _decodeCount++;

        public void RecordRendered() => _renderCount++;

        public void RecordQueueDrop(int totalDropped) => QueueDropped = totalDropped;

        public (double decodeFps, double renderFps, int queueDropped) SampleAndReset()
        {
            var now = DateTime.UtcNow;
            double seconds = Math.Max(0.001, (now - _lastSample).TotalSeconds);
            _lastSample = now;

            double decodeFps = (_decodeCount - _lastDecodeCount) / seconds;
            double renderFps = (_renderCount - _lastRenderCount) / seconds;
            _lastDecodeCount = _decodeCount;
            _lastRenderCount = _renderCount;

            return (decodeFps, renderFps, QueueDropped);
        }
    }
}
