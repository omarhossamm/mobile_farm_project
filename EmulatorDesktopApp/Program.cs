using Avalonia;
using System;

namespace EmulatorDesktopApp;

class Program
{
    /// <summary>
    /// Contract tag the extension asserts against BUILD_INFO.json. Bump
    /// this in lockstep with scripts/bootstrap.js
    /// (REQUIRED_DESKTOP_APP_FEATURES) and src/desktopAppFreshness.ts
    /// on the extension side whenever the extension→desktop-app
    /// protocol changes in a way an older binary can't handle.
    /// Logging it on stdout on every run lets the user (and this
    /// author) instantly confirm "yes, this is the freshly-built
    /// binary" even without the log file.
    /// </summary>
    public const string BuildFeatureTag = "headless-attach-v1";

    // Initialization code. Don't use any Avalonia, third-party APIs or any
    // SynchronizationContext-reliant code before AppMain is called: things aren't initialized
    // yet and stuff might break.
    [STAThread]
    public static void Main(string[] args)
    {
        // Windows WinExe apps have no console attached — Console.WriteLine
        // vanishes. Route diagnostics through StartupLog which writes to
        // a well-known file (`%TEMP%/EmulatorDesktopApp.log` on Windows,
        // `$TMPDIR/EmulatorDesktopApp.log` on Mac/Linux). This is the
        // only way to figure out what happened after a bad launch on
        // Windows — first thing we log is the raw args.
        StartupLog.Init();
        StartupLog.Info($"EmulatorDesktopApp starting — feature={BuildFeatureTag} pid={Environment.ProcessId} os={Environment.OSVersion} clr={Environment.Version}");
        StartupLog.Info($"raw args count={args.Length}");
        for (int i = 0; i < args.Length; i++)
        {
            StartupLog.Info($"  args[{i}] = {StartupLog.Quote(args[i])}");
        }

        // Parse our own CLI args before Avalonia consumes them. The
        // extension host passes --server / --device / --auto-start / --session-id
        // to drive an unattended launch; when the user runs the app
        // directly no args are set and the classic UI flow is used.
        LaunchOptions.ParseFromCommandLine(args);
        var opts = LaunchOptions.Current;
        StartupLog.Info(
            $"parsed: AutoStart={opts.AutoStart} " +
            $"Server={StartupLog.Quote(opts.Server ?? "")} " +
            $"DeviceId={StartupLog.Quote(opts.DeviceId ?? "")} " +
            $"SessionId={StartupLog.Quote(opts.SessionId ?? "")} " +
            $"NoManualControls={opts.NoManualControls}");

        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
        StartupLog.Info("Avalonia lifetime returned — process exiting");
    }

    // Avalonia configuration, don't remove; also used by visual designer.
    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
#if DEBUG
            .WithDeveloperTools()
#endif
            .WithInterFont()
            .LogToTrace();
}
