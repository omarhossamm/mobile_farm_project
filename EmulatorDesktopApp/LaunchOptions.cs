using System;
using System.Collections.Generic;

namespace EmulatorDesktopApp;

/// <summary>
/// CLI arguments parsed at process start. When the VS Code / Cursor
/// extension launches this app it passes:
///   --server ws://host:port         (WebSocket URL)
///   --device DEVICE_ID              (pin the target emulator/simulator)
///   --auto-start                    (skip the manual click-through:
///                                    connect, pick device, create
///                                    session, start streaming — all
///                                    automatically)
///   --no-manual-controls            (optional: hide the top toolbar
///                                    since the extension owns the flow)
///
/// When invoked with no args, the app behaves exactly as before (manual
/// connect/refresh/start UI).
/// </summary>
public sealed class LaunchOptions
{
    public string? Server { get; init; }
    public string? DeviceId { get; init; }
    public bool AutoStart { get; init; }
    public bool NoManualControls { get; init; }

    /// <summary>Populated by Program.Main before BuildAvaloniaApp.</summary>
    public static LaunchOptions Current { get; private set; } = new();

    public static void ParseFromCommandLine(string[] args)
    {
        string? server = null;
        string? deviceId = null;
        bool autoStart = false;
        bool noManualControls = false;

        for (int i = 0; i < args.Length; i++)
        {
            var a = args[i];
            switch (a)
            {
                case "--server":
                case "-s":
                    if (i + 1 < args.Length) { server = args[++i]; }
                    break;
                case "--device":
                case "-d":
                    if (i + 1 < args.Length) { deviceId = args[++i]; }
                    break;
                case "--auto-start":
                case "--auto":
                    autoStart = true;
                    break;
                case "--no-manual-controls":
                    noManualControls = true;
                    break;
                default:
                    if (a.StartsWith("--server=", StringComparison.Ordinal)) server = a.Substring("--server=".Length);
                    else if (a.StartsWith("--device=", StringComparison.Ordinal)) deviceId = a.Substring("--device=".Length);
                    break;
            }
        }

        Current = new LaunchOptions
        {
            Server = server,
            DeviceId = deviceId,
            AutoStart = autoStart,
            NoManualControls = noManualControls,
        };
    }
}
