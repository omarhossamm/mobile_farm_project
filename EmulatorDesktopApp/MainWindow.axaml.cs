using Avalonia.Controls;
using Avalonia.Threading;
using EmulatorDesktopApp.ViewModels;
using System.ComponentModel;

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
