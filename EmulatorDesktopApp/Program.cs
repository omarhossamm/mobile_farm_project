using Avalonia;
using System;

namespace EmulatorDesktopApp;

class Program
{
    // Initialization code. Don't use any Avalonia, third-party APIs or any
    // SynchronizationContext-reliant code before AppMain is called: things aren't initialized
    // yet and stuff might break.
    [STAThread]
    public static void Main(string[] args)
    {
        // Parse our own CLI args before Avalonia consumes them. The
        // extension host passes --server / --device / --auto-start to
        // drive an unattended launch; when the user runs the app
        // directly no args are set and the classic UI flow is used.
        LaunchOptions.ParseFromCommandLine(args);
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
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
