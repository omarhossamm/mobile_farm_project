using System.Text.Json;
using EmulatorDesktopApp.Services;

const double Tol = 1e-6;
int failures = 0;

// Resolve the shared vectors file (server-authored, single source of truth).
string vectorsPath = args.Length > 0
    ? args[0]
    : Path.GetFullPath(Path.Combine(
        AppContext.BaseDirectory,
        "../../../../../websocket_nodejs/adb-emulator-server/stream/core/geometry-test-vectors.json"));

if (!File.Exists(vectorsPath))
{
    Console.Error.WriteLine($"vectors file not found: {vectorsPath}");
    return 2;
}

using var doc = JsonDocument.Parse(File.ReadAllText(vectorsPath));
var root = doc.RootElement;

void Check(string label, double a, double b)
{
    if (Math.Abs(a - b) > Tol)
    {
        Console.Error.WriteLine($"FAIL {label}: {a} != {b}");
        failures++;
    }
}

// rotationRoundTrip: device → display (F) and display → device (G inverse).
foreach (var v in root.GetProperty("rotationRoundTrip").EnumerateArray())
{
    var dn = v.GetProperty("deviceN");
    var disp = v.GetProperty("displayN");
    int rot = v.GetProperty("rotation").GetInt32();
    double dnx = dn.GetProperty("nx").GetDouble(), dny = dn.GetProperty("ny").GetDouble();

    var f = GeometryModel.DeviceNormalizedToDisplay(dnx, dny, rot);
    Check($"F_{rot}.nx", f.nx, disp.GetProperty("nx").GetDouble());
    Check($"F_{rot}.ny", f.ny, disp.GetProperty("ny").GetDouble());

    var g = GeometryModel.DisplayToDeviceNormalized(disp.GetProperty("nx").GetDouble(), disp.GetProperty("ny").GetDouble(), rot);
    Check($"G_{rot}.nx", g.nx, dnx);
    Check($"G_{rot}.ny", g.ny, dny);
}

// contentRect
foreach (var v in root.GetProperty("contentRect").EnumerateArray())
{
    var view = v.GetProperty("view");
    var stream = v.GetProperty("stream");
    var rect = v.GetProperty("rect");
    bool ok = GeometryModel.ContentRect(
        view.GetProperty("w").GetDouble(), view.GetProperty("h").GetDouble(),
        stream.GetProperty("w").GetDouble(), stream.GetProperty("h").GetDouble(),
        out var x, out var y, out var w, out var h);
    if (!ok) { Console.Error.WriteLine("FAIL contentRect computation"); failures++; continue; }
    Check("rect.x", x, rect.GetProperty("x").GetDouble());
    Check("rect.y", y, rect.GetProperty("y").GetDouble());
    Check("rect.w", w, rect.GetProperty("w").GetDouble());
    Check("rect.h", h, rect.GetProperty("h").GetDouble());
}

// devicePoints
foreach (var v in root.GetProperty("devicePoints").EnumerateArray())
{
    var dn = v.GetProperty("deviceN");
    var dl = v.GetProperty("deviceLogical");
    var pts = v.GetProperty("points");
    var p = GeometryModel.NormalizedToDevicePoints(
        dn.GetProperty("nx").GetDouble(), dn.GetProperty("ny").GetDouble(),
        dl.GetProperty("w").GetDouble(), dl.GetProperty("h").GetDouble());
    Check("points.x", p.x, pts.GetProperty("x").GetDouble());
    Check("points.y", p.y, pts.GetProperty("y").GetDouble());
}

if (failures == 0)
{
    Console.WriteLine("GEOMETRY PARITY OK — C# matches shared vectors");
    return 0;
}
Console.Error.WriteLine($"GEOMETRY PARITY FAILED — {failures} mismatch(es)");
return 1;
