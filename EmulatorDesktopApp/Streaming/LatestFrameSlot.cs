using System.Threading;
using EmulatorDesktopApp.Services;

namespace EmulatorDesktopApp.Streaming
{
    /// <summary>
    /// Single-slot buffer: at most one decoded frame waiting for the render worker.
    /// </summary>
    internal sealed class LatestFrameSlot
    {
        private readonly object _gate = new();
        private VideoFrameInfo? _pending;
        private long _replaced;

        public long ReplacedCount => Interlocked.Read(ref _replaced);

        /// <summary>Stores the newest frame; releases any previous pending frame.</summary>
        public void Set(VideoFrameInfo frame)
        {
            lock (_gate)
            {
                if (_pending != null)
                {
                    _pending.Release();
                    Interlocked.Increment(ref _replaced);
                }

                _pending = frame;
            }
        }

        public bool TryTake(out VideoFrameInfo? frame)
        {
            lock (_gate)
            {
                frame = _pending;
                _pending = null;
            }

            return frame != null;
        }

        public void Clear()
        {
            lock (_gate)
            {
                _pending?.Release();
                _pending = null;
            }
        }
    }
}
