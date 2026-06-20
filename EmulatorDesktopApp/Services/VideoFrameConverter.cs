using System;
using System.Runtime.InteropServices;
using Avalonia.Platform;

namespace EmulatorDesktopApp.Services
{
    /// <summary>
    /// Pixel-format detection and BGR/RGB → BGRA copy helpers used by the
    /// render pipeline. All routines assume the source buffer is already
    /// decoded (FFmpeg / SIPSorcery hands us raw frames); encoded codec
    /// payloads must not reach this class.
    /// </summary>
    public static class VideoFrameConverter
    {
        private static bool IsEncodedCodecHint(string formatHint)
        {
            string hint = formatHint?.ToUpperInvariant() ?? string.Empty;
            return hint.Contains("VP8") || hint.Contains("VP9") || hint.Contains("H264")
                || hint.Contains("H265") || hint.Contains("HEVC") || hint.Contains("AV1");
        }

        /// <summary>
        /// Best-effort pixel-format detection from the decoder's hint and
        /// the actual buffer dimensions. The render pipeline uses the
        /// returned tag to pick the right Copy* routine below.
        /// </summary>
        public static string DetectFormat(int dataLength, int width, int height, string formatHint, int stride = 0)
        {
            if (width <= 0 || height <= 0)
                return "Unknown";

            if (IsEncodedCodecHint(formatHint))
                return "Encoded";

            string hint = formatHint?.ToUpperInvariant() ?? string.Empty;

            if (hint.Contains("BGRA") || hint == "BGRA")
                return "BGRA32";
            if (hint.Contains("BGR") || hint == "BGR")
                return "BGR24";
            if (hint.Contains("RGB") || hint == "RGB")
                return "RGB24";
            if (hint.Contains("I420") || hint.Contains("NV12") || hint.Contains("YUV"))
                return "I420";

            int rowBytes = stride > 0 ? stride : width * 4;
            if (dataLength >= rowBytes * height && rowBytes >= width * 4)
                return "BGRA32";
            rowBytes = stride > 0 ? stride : width * 3;
            if (dataLength >= rowBytes * height && rowBytes >= width * 3)
                return "BGR24";
            if (dataLength == (width * height * 3) / 2)
                return "I420";

            return "Unknown";
        }

        /// <summary>
        /// Row-by-row copy of BGRA pixels into an Avalonia locked framebuffer.
        /// The render worker writes directly into the destination bitmap with
        /// no intermediate scratch buffer.
        /// </summary>
        public static void CopyBgraToLocked(byte[] src, int width, int height, int srcStride, ILockedFramebuffer dest)
        {
            int rowBytes = width * 4;
            int effectiveStride = srcStride > 0 ? srcStride : rowBytes;
            int destStride = dest.RowBytes;
            unsafe
            {
                byte* dst = (byte*)dest.Address;
                for (int y = 0; y < height; y++)
                {
                    Marshal.Copy(src, y * effectiveStride, (IntPtr)(dst + y * destStride), rowBytes);
                }
            }
        }

        /// <summary>
        /// Expands BGR24 → BGRA32 directly into an Avalonia locked framebuffer,
        /// bypassing the intermediate scratch buffer used by <see cref="CopyBgr24ToBgraBuffer"/>.
        /// One memcpy instead of two; called by the render worker.
        /// </summary>
        public static bool CopyBgr24ToLocked(byte[] bgr, int width, int height, int srcStride, ILockedFramebuffer dest)
        {
            int effectiveSrc = srcStride > 0 ? srcStride : width * 3;
            int destStride = dest.RowBytes;
            unsafe
            {
                fixed (byte* pSrc = bgr)
                {
                    byte* pDst = (byte*)dest.Address;
                    for (int y = 0; y < height; y++)
                    {
                        byte* s = pSrc + y * effectiveSrc;
                        byte* d = pDst + y * destStride;
                        int x = 0;
                        int w = width;
                        for (; x < w - 3; x += 4)
                        {
                            int si = x * 3;
                            int di = x * 4;
                            d[di + 0] = s[si + 0];
                            d[di + 1] = s[si + 1];
                            d[di + 2] = s[si + 2];
                            d[di + 3] = 255;
                            d[di + 4] = s[si + 3];
                            d[di + 5] = s[si + 4];
                            d[di + 6] = s[si + 5];
                            d[di + 7] = 255;
                            d[di + 8] = s[si + 6];
                            d[di + 9] = s[si + 7];
                            d[di + 10] = s[si + 8];
                            d[di + 11] = 255;
                            d[di + 12] = s[si + 9];
                            d[di + 13] = s[si + 10];
                            d[di + 14] = s[si + 11];
                            d[di + 15] = 255;
                        }

                        for (; x < w; x++)
                        {
                            int si = x * 3;
                            int di = x * 4;
                            d[di + 0] = s[si + 0];
                            d[di + 1] = s[si + 1];
                            d[di + 2] = s[si + 2];
                            d[di + 3] = 255;
                        }
                    }
                }
            }

            return true;
        }

        /// <summary>
        /// Expands RGB24 → BGRA32 (channel swap) directly into an Avalonia locked
        /// framebuffer. Counterpart of <see cref="CopyBgr24ToLocked"/>.
        /// </summary>
        public static bool CopyRgb24ToLocked(byte[] rgb, int width, int height, int srcStride, ILockedFramebuffer dest)
        {
            int effectiveSrc = srcStride > 0 ? srcStride : width * 3;
            int destStride = dest.RowBytes;
            unsafe
            {
                fixed (byte* pSrc = rgb)
                {
                    byte* pDst = (byte*)dest.Address;
                    for (int y = 0; y < height; y++)
                    {
                        byte* s = pSrc + y * effectiveSrc;
                        byte* d = pDst + y * destStride;
                        int x = 0;
                        int w = width;
                        for (; x < w - 3; x += 4)
                        {
                            int si = x * 3;
                            int di = x * 4;
                            d[di + 0] = s[si + 2];
                            d[di + 1] = s[si + 1];
                            d[di + 2] = s[si + 0];
                            d[di + 3] = 255;
                            d[di + 4] = s[si + 5];
                            d[di + 5] = s[si + 4];
                            d[di + 6] = s[si + 3];
                            d[di + 7] = 255;
                            d[di + 8] = s[si + 8];
                            d[di + 9] = s[si + 7];
                            d[di + 10] = s[si + 6];
                            d[di + 11] = 255;
                            d[di + 12] = s[si + 11];
                            d[di + 13] = s[si + 10];
                            d[di + 14] = s[si + 9];
                            d[di + 15] = 255;
                        }

                        for (; x < w; x++)
                        {
                            int si = x * 3;
                            int di = x * 4;
                            d[di + 0] = s[si + 2];
                            d[di + 1] = s[si + 1];
                            d[di + 2] = s[si + 0];
                            d[di + 3] = 255;
                        }
                    }
                }
            }

            return true;
        }
    }
}
