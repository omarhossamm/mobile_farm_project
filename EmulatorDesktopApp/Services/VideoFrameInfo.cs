using System;
using System.Buffers;
using System.Runtime.InteropServices;
using SIPSorceryMedia.Abstractions;

namespace EmulatorDesktopApp.Services
{
    /// <summary>
    /// Decoded video frame for rendering. May own an ArrayPool buffer — call <see cref="Release"/> when done.
    /// </summary>
    public sealed class VideoFrameInfo
    {
        private byte[]? _pooled;

        public byte[] Data { get; private set; } = Array.Empty<byte>();
        public int Width { get; set; }
        public int Height { get; set; }
        public string Format { get; set; } = string.Empty;
        public int Stride { get; set; }
        public uint Timestamp { get; set; }

        public static VideoFrameInfo FromRawImage(RawImage rawImage)
        {
            if (rawImage == null || rawImage.Width <= 0 || rawImage.Height <= 0)
                return new VideoFrameInfo();

            int stride = rawImage.Stride > 0 ? rawImage.Stride : rawImage.Width * 3;
            int byteCount = stride * rawImage.Height;
            if (byteCount <= 0)
                return new VideoFrameInfo();

            // ALWAYS copy: SIPSorcery / FFmpeg reuse the same AVFrame buffer for
            // every decoded picture. Holding a reference would cause us to read
            // pixels mid-write on the next decoded frame (visible as ghosting /
            // overlapping copies of UI elements).
            byte[] pooled = ArrayPool<byte>.Shared.Rent(byteCount);
            bool copied = false;

            byte[]? src = rawImage.GetBuffer();
            if (src != null && src.Length >= byteCount)
            {
                Buffer.BlockCopy(src, 0, pooled, 0, byteCount);
                copied = true;
            }
            else if (rawImage.Sample != IntPtr.Zero)
            {
                Marshal.Copy(rawImage.Sample, pooled, 0, byteCount);
                copied = true;
            }

            if (!copied)
            {
                ArrayPool<byte>.Shared.Return(pooled);
                return new VideoFrameInfo();
            }

            return new VideoFrameInfo
            {
                _pooled = pooled,
                Data = pooled,
                Width = rawImage.Width,
                Height = rawImage.Height,
                Stride = stride,
                Format = rawImage.PixelFormat.ToString(),
                Timestamp = (uint)Environment.TickCount
            };
        }

        public void Release()
        {
            if (_pooled != null)
            {
                ArrayPool<byte>.Shared.Return(_pooled);
                _pooled = null;
            }

            Data = Array.Empty<byte>();
        }
    }
}
