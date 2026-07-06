using System;
using System.ComponentModel;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Threading;
using EmulatorDesktopApp.ViewModels;

namespace EmulatorDesktopApp;

/// <summary>
/// Main window code-behind. Handles view-specific logic like auto-scrolling.
/// </summary>
public partial class MainWindow : Window
{
    private MainWindowViewModel? _viewModel;
    private StreamWindow? _streamWindow;

    public MainWindow()
    {
        InitializeComponent();
        DataContext = new MainWindowViewModel(OpenStreamWindow, CloseStreamWindow);
        Loaded += OnWindowLoaded;
    }

    protected override void OnOpened(EventArgs e)
    {
        base.OnOpened(e);
        ApplyDynamicStartupSize();
    }

    /// Size the window to a fraction of the current monitor's work area so it
    /// scales with the machine's screen, then re-center it. The window stays
    /// freely resizable (Avalonia windows are resizable by default).
    private void ApplyDynamicStartupSize()
    {
        var screen = Screens?.ScreenFromWindow(this) ?? Screens?.Primary;
        if (screen == null)
            return;

        double scaling = screen.Scaling <= 0 ? 1.0 : screen.Scaling;
        var workArea = screen.WorkingArea;
        double logicalWidth = workArea.Width / scaling;
        double logicalHeight = workArea.Height / scaling;

        double width = Math.Clamp(logicalWidth * 0.80, MinWidth, logicalWidth);
        double height = Math.Clamp(logicalHeight * 0.85, MinHeight, logicalHeight);

        Width = width;
        Height = height;

        int x = workArea.X + (int)((workArea.Width - width * scaling) / 2);
        int y = workArea.Y + (int)((workArea.Height - height * scaling) / 2);
        Position = new PixelPoint(x, y);
    }

    private void OpenStreamWindow(StreamWindowViewModel viewModel)
    {
        CloseStreamWindow();
        _streamWindow = new StreamWindow
        {
            DataContext = viewModel
        };
        viewModel.OnFrameUpdated = () => _streamWindow.InvalidateVideoFrame();
        _streamWindow.Closed += (_, _) =>
        {
            (DataContext as MainWindowViewModel)?.NotifyStreamWindowClosed();
            _streamWindow = null;
        };
        _streamWindow.Show();
    }

    private void CloseStreamWindow()
    {
        if (_streamWindow == null)
            return;

        var window = _streamWindow;
        _streamWindow = null;

        try
        {
            window.Close();
        }
        catch
        {
            // Window may already be closing during stream teardown.
        }
    }

    private void OnWindowLoaded(object? sender, Avalonia.Interactivity.RoutedEventArgs e)
    {
        _viewModel = DataContext as MainWindowViewModel;

        if (_viewModel != null)
            _viewModel.PropertyChanged += OnViewModelPropertyChanged;

        // Extension-driven launch: run the whole connect/pick/stream
        // chain automatically. Falls back to the classic manual UI when
        // no --auto-start flag was passed.
        var opts = LaunchOptions.Current;
        if (_viewModel != null && opts.AutoStart && !string.IsNullOrWhiteSpace(opts.Server) && !string.IsNullOrWhiteSpace(opts.DeviceId))
        {
            _ = _viewModel.AutoStartAsync(opts.Server!, opts.DeviceId!);
        }
    }

    private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(MainWindowViewModel.Logs))
        {
            Dispatcher.UIThread.Post(() =>
            {
                var logsTextBlock = this.FindControl<SelectableTextBlock>("LogsTextBlock");
                var scrollViewer = logsTextBlock?.Parent as ScrollViewer;

                scrollViewer?.ScrollToEnd();
            }, DispatcherPriority.Background);
        }
    }

    protected override void OnClosing(WindowClosingEventArgs e)
    {
        if (_viewModel != null)
        {
            _viewModel.PropertyChanged -= OnViewModelPropertyChanged;
            _viewModel.Dispose();
        }

        base.OnClosing(e);
    }
}
