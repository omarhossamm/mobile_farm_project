using System;

namespace EmulatorDesktopApp.Services
{
    /// <summary>
    /// Authoritative client-side coordinate math — the C# mirror of the server's
    /// <c>stream/core/captureGeometry.js</c>. Both implementations are validated
    /// against the same shared vectors (geometry-test-vectors.json) so the touch
    /// transform is identical on both ends: no duplicate mappers, no magic
    /// offsets, no hardcoded device dimensions.
    ///
    /// Touch transform (UI pointer → device points):
    ///   ViewToDisplayNormalized (letterbox)  → display-normalized [0,1]
    ///   DisplayToDeviceNormalized (rotation) → device-normalized [0,1]
    ///   NormalizedToDevicePoints             → device points (HID basis)
    ///
    /// Uses plain doubles only (no Avalonia types) so it stays trivially testable.
    /// </summary>
    public static class GeometryModel
    {
        public static double Clamp01(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return 0;
            return v < 0 ? 0 : v > 1 ? 1 : v;
        }

        public static int NormalizeRotation(double rotation)
        {
            var r = ((int)Math.Round(rotation) % 360 + 360) % 360;
            return r == 90 || r == 180 || r == 270 ? r : 0;
        }

        /// <summary>
        /// Letterbox content rect (Stretch=Uniform) of stream inscribed in view.
        /// Returns false when any dimension is non-positive.
        /// </summary>
        public static bool ContentRect(
            double viewW, double viewH, double streamW, double streamH,
            out double x, out double y, out double w, out double h)
        {
            x = y = w = h = 0;
            if (viewW <= 0 || viewH <= 0 || streamW <= 0 || streamH <= 0) return false;

            double videoAspect = streamW / streamH;
            double viewAspect = viewW / viewH;
            if (viewAspect > videoAspect)
            {
                h = viewH;
                w = h * videoAspect;
            }
            else
            {
                w = viewW;
                h = w / videoAspect;
            }
            x = (viewW - w) / 2;
            y = (viewH - h) / 2;
            return true;
        }

        /// <summary>
        /// UI pointer (in the video control) → display-normalized [0,1],
        /// letterbox-aware. Returns false if the point is outside the content rect.
        /// </summary>
        public static bool ViewToDisplayNormalized(
            double px, double py, double viewW, double viewH, double streamW, double streamH,
            out double nx, out double ny)
        {
            nx = ny = 0;
            if (!ContentRect(viewW, viewH, streamW, streamH, out var x, out var y, out var w, out var h))
                return false;
            if (px < x || py < y || px > x + w || py > y + h)
                return false;
            nx = Clamp01((px - x) / w);
            ny = Clamp01((py - y) / h);
            return true;
        }

        /// <summary>Inverse rotation G_r: display-normalized → device-normalized.</summary>
        public static (double nx, double ny) DisplayToDeviceNormalized(double nx, double ny, double rotation)
        {
            double x = Clamp01(nx), yy = Clamp01(ny);
            return NormalizeRotation(rotation) switch
            {
                90 => (yy, 1 - x),
                180 => (1 - x, 1 - yy),
                270 => (1 - yy, x),
                _ => (x, yy)
            };
        }

        /// <summary>device-normalized [0,1] → device points (logical).</summary>
        public static (double x, double y) NormalizedToDevicePoints(double nx, double ny, double logicalW, double logicalH)
            => (Clamp01(nx) * logicalW, Clamp01(ny) * logicalH);
    }
}
