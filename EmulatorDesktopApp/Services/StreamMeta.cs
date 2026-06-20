using System.Text.Json;

namespace EmulatorDesktopApp.Services
{
    /// <summary>
    /// Stream geometry metadata from server <c>stream_started.stream_meta</c>.
    /// Used by <see cref="CoordinateMapper"/>.
    /// </summary>
    public sealed class StreamMeta
    {
        public string Provider { get; init; } = string.Empty;
        public string CoordinateSpace { get; init; } = "device_logical";
        public string Platform { get; init; } = string.Empty;
        public int DeviceLogicalWidth { get; init; }
        public int DeviceLogicalHeight { get; init; }
        public int StreamWidth { get; init; }
        public int StreamHeight { get; init; }
        public bool Cropped { get; init; }

        /// <summary>Displayed-frame clockwise rotation relative to device (0/90/180/270).</summary>
        public int Rotation { get; init; }

        /// <summary>Device pixels per logical point (retina scale).</summary>
        public double BackingScale { get; init; } = 1.0;

        /// <summary>Touch region origin X in stream pixels (default 0).</summary>
        public int TouchOriginX { get; init; }

        /// <summary>Touch region origin Y in stream pixels (default 0).</summary>
        public int TouchOriginY { get; init; }

        /// <summary>Touch region width in stream pixels (defaults to stream width).</summary>
        public int TouchWidth { get; init; }

        /// <summary>Touch region height in stream pixels (defaults to stream height).</summary>
        public int TouchHeight { get; init; }

        public static StreamMeta? TryParse(JsonElement? element)
        {
            if (element is not { ValueKind: JsonValueKind.Object } el)
                return null;

            return FromJsonElement(el);
        }

        public static StreamMeta FromJsonElement(JsonElement el) => new()
        {
            Provider = el.TryGetProperty("provider", out var p) ? p.GetString() ?? "" : "",
            CoordinateSpace = el.TryGetProperty("coordinate_space", out var cs)
                ? cs.GetString() ?? "device_logical"
                : "device_logical",
            Platform = el.TryGetProperty("platform", out var pl) ? pl.GetString() ?? "" : "",
            DeviceLogicalWidth = el.TryGetProperty("device_logical_width", out var dw) ? dw.GetInt32() : 0,
            DeviceLogicalHeight = el.TryGetProperty("device_logical_height", out var dh) ? dh.GetInt32() : 0,
            StreamWidth = el.TryGetProperty("stream_width", out var sw) ? sw.GetInt32() : 0,
            StreamHeight = el.TryGetProperty("stream_height", out var sh) ? sh.GetInt32() : 0,
            Cropped = el.TryGetProperty("cropped", out var cr) && cr.GetBoolean(),
            Rotation = el.TryGetProperty("rotation", out var rot) && rot.ValueKind == JsonValueKind.Number ? rot.GetInt32() : 0,
            BackingScale = el.TryGetProperty("backing_scale", out var bs) && bs.ValueKind == JsonValueKind.Number ? bs.GetDouble() : 1.0,
            TouchOriginX = el.TryGetProperty("touch_origin_x", out var tox) ? tox.GetInt32() : 0,
            TouchOriginY = el.TryGetProperty("touch_origin_y", out var toy) ? toy.GetInt32() : 0,
            TouchWidth = el.TryGetProperty("touch_width", out var tw) ? tw.GetInt32() : 0,
            TouchHeight = el.TryGetProperty("touch_height", out var th) ? th.GetInt32() : 0
        };

        public StreamMeta WithStreamSize(int streamW, int streamH, bool? cropped = null) => new()
        {
            Provider = Provider,
            CoordinateSpace = CoordinateSpace,
            Platform = Platform,
            DeviceLogicalWidth = DeviceLogicalWidth,
            DeviceLogicalHeight = DeviceLogicalHeight,
            StreamWidth = streamW,
            StreamHeight = streamH,
            Cropped = cropped ?? Cropped,
            Rotation = Rotation,
            BackingScale = BackingScale,
            TouchOriginX = 0,
            TouchOriginY = 0,
            TouchWidth = streamW,
            TouchHeight = streamH
        };
    }
}
