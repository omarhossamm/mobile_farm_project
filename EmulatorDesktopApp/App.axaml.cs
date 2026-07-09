using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Threading;
using EmulatorDesktopApp.ViewModels;

namespace EmulatorDesktopApp;

/// <summary>
/// Application entry point and configuration.
///
/// Two launch modes:
///
///   1. Interactive (default): MainWindow becomes the main window and
///      the user drives connect → session → stream by hand. Standard
///      Avalonia lifetime — the app quits when MainWindow closes.
///
///   2. Auto-start (--auto-start passed via LaunchOptions):
///      MainWindow is never created or shown. We build a
///      MainWindowViewModel headlessly, wire up the OpenStreamWindow /
///      CloseStreamWindow callbacks to open StreamWindow directly, and
///      call AutoStartAsync. The user sees ONLY the streaming window.
///      The app exits when that window closes.
/// </summary>
public partial class App : Application
{
    private StreamWindow? _streamWindow;
    private MainWindowViewModel? _headlessViewModel;

    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var opts = LaunchOptions.Current;
            var shouldHeadless =
                opts.AutoStart &&
                !string.IsNullOrWhiteSpace(opts.Server) &&
                !string.IsNullOrWhiteSpace(opts.DeviceId);

            StartupLog.Info(
                $"OnFrameworkInitializationCompleted: shouldHeadless={shouldHeadless} " +
                $"AutoStart={opts.AutoStart} Server?={!string.IsNullOrWhiteSpace(opts.Server)} " +
                $"DeviceId?={!string.IsNullOrWhiteSpace(opts.DeviceId)}");

            if (shouldHeadless)
            {
                // Explicit shutdown: no MainWindow, no auto-quit when
                // there are momentarily zero windows during the async
                // connect/negotiate phase. We call Shutdown() ourselves
                // once the streaming window closes (or the auto-start
                // flow can't produce one).
                desktop.ShutdownMode = ShutdownMode.OnExplicitShutdown;
                StartHeadless(desktop, opts);
            }
            else
            {
                StartupLog.Info("Interactive mode: creating MainWindow");
                desktop.MainWindow = new MainWindow();
            }
        }
        else
        {
            StartupLog.Info($"ApplicationLifetime is NOT IClassicDesktopStyleApplicationLifetime — was {ApplicationLifetime?.GetType().FullName ?? "<null>"}");
        }

        base.OnFrameworkInitializationCompleted();
    }

    private void StartHeadless(IClassicDesktopStyleApplicationLifetime desktop, LaunchOptions opts)
    {
        StartupLog.Info("Headless mode: MainWindow suppressed; will show StreamWindow only");
        var vm = new MainWindowViewModel(OpenStreamWindow, CloseStreamWindow);
        _headlessViewModel = vm;

        // Kick off after the framework message loop is running so
        // async continuations have a live UI SynchronizationContext.
        Dispatcher.UIThread.Post(async () =>
        {
            try
            {
                await vm.AutoStartAsync(opts.Server!, opts.DeviceId!, opts.SessionId);
            }
            catch (System.Exception ex)
            {
                // Errors are already appended to the ViewModel log; we
                // just make sure the process doesn't hang if the auto-
                // start pipeline throws before OpenStreamWindow runs.
                StartupLog.Info($"AutoStartAsync threw: {ex.Message}");
            }

            // If auto-start finished (with or without success) and no
            // stream window ever opened, there's nothing to display —
            // exit cleanly instead of leaving a zombie process.
            if (_streamWindow == null)
            {
                StartupLog.Info("AutoStart finished with no StreamWindow → shutdown");
                desktop.Shutdown(0);
            }
        });
    }

    private void OpenStreamWindow(StreamWindowViewModel svm)
    {
        StartupLog.Info("OpenStreamWindow (headless mode, main window never shown)");
        CloseStreamWindow();
        _streamWindow = new StreamWindow { DataContext = svm };
        svm.OnFrameUpdated = () => _streamWindow?.InvalidateVideoFrame();
        _streamWindow.Closed += (_, _) =>
        {
            _headlessViewModel?.NotifyStreamWindowClosed();
            _streamWindow = null;
            // The stream window closing is the user's "quit" gesture
            // in headless mode — tear down the whole process.
            if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime d)
            {
                _headlessViewModel?.Dispose();
                _headlessViewModel = null;
                d.Shutdown(0);
            }
        };
        _streamWindow.Show();
    }

    private void CloseStreamWindow()
    {
        var w = _streamWindow;
        _streamWindow = null;
        if (w == null) return;
        try { w.Close(); }
        catch
        {
            // The window may already be closing during teardown.
        }
    }
}
