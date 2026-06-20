using Avalonia;
using EmulatorDesktopApp.ViewModels;

namespace EmulatorDesktopApp.Services
{
    /// <summary>
    /// Maps pointer positions in the stream window to normalized [0,1] device
    /// logical coordinates using stream metadata and letterbox-aware layout.
    /// </summary>
    public sealed class CoordinateMapper
    {
        public StreamMeta? Meta { get; private set; }

        public void Apply(StreamMeta? meta) => Meta = meta;

        /// <summary>
        /// Expected video aspect for layout when decoded frame size is not yet known.
        /// </summary>
        public Size? PreferredVideoSize
        {
            get
            {
                if (Meta == null) return null;
                var w = Meta.StreamWidth > 0 ? Meta.StreamWidth : Meta.DeviceLogicalWidth;
                var h = Meta.StreamHeight > 0 ? Meta.StreamHeight : Meta.DeviceLogicalHeight;
                return w > 0 && h > 0 ? new Size(w, h) : null;
            }
        }

        /// <summary>
        /// Map a UI pointer to DEVICE-normalized [0,1] coordinates: letterbox
        /// removal (GeometryModel.ViewToDisplayNormalized) followed by the
        /// inverse rotation from <see cref="StreamMeta.Rotation"/>. The result is
        /// what the server control provider multiplies by device-logical points.
        /// </summary>
        public bool TryNormalize(
            Point position,
            Size viewSize,
            Size videoSize,
            out double nx,
            out double ny)
        {
            nx = ny = 0;
            if (viewSize.Width <= 0 || viewSize.Height <= 0)
                return false;

            var effectiveVideo = videoSize;
            if (effectiveVideo.Width <= 0 || effectiveVideo.Height <= 0)
            {
                var pref = PreferredVideoSize;
                if (pref.HasValue)
                    effectiveVideo = pref.Value;
            }

            // No known video size → fall back to raw view-relative normalization.
            if (effectiveVideo.Width <= 0 || effectiveVideo.Height <= 0)
            {
                nx = GeometryModel.Clamp01(position.X / viewSize.Width);
                ny = GeometryModel.Clamp01(position.Y / viewSize.Height);
                return true;
            }

            if (!GeometryModel.ViewToDisplayNormalized(
                    position.X, position.Y, viewSize.Width, viewSize.Height,
                    effectiveVideo.Width, effectiveVideo.Height,
                    out var dnx, out var dny))
                return false;

            var (rnx, rny) = GeometryModel.DisplayToDeviceNormalized(dnx, dny, Meta?.Rotation ?? 0);
            nx = rnx;
            ny = rny;
            return true;
        }

        public (double x, double y) NormalizedToDevicePoints(double nx, double ny)
        {
            var w = Meta?.DeviceLogicalWidth ?? 0;
            var h = Meta?.DeviceLogicalHeight ?? 0;
            if (w <= 0 || h <= 0)
                return (nx, ny);
            return GeometryModel.NormalizedToDevicePoints(nx, ny, w, h);
        }
    }
}
