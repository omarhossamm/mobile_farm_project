using Avalonia.Controls;
using Avalonia.Threading;
using EmulatorDesktopApp.ViewModels;
using System;
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
        _streamWindow.Closed += (_, _) => _streamWindow = null;
        _streamWindow.Show();
    }

    private void CloseStreamWindow()
    {
        if (_streamWindow == null)
            return;

        _streamWindow.Close();
        _streamWindow = null;
    }

    private void OnWindowLoaded(object? sender, Avalonia.Interactivity.RoutedEventArgs e)
    {
        // Get reference to the ViewModel for property change subscription
        _viewModel = DataContext as MainWindowViewModel;
        
        if (_viewModel != null)
        {
            _viewModel.PropertyChanged += OnViewModelPropertyChanged;
        }
    }

    /// <summary>
    /// Auto-scrolls the logs window when new content is added.
    /// </summary>
    private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(MainWindowViewModel.Logs))
        {
            // Use dispatcher to ensure we scroll after the UI has updated
            Dispatcher.UIThread.Post(() =>
            {
                // Find ScrollViewer by walking up from LogsTextBlock or use the grid structure
                var logsTextBlock = this.FindControl<SelectableTextBlock>("LogsTextBlock");
                var scrollViewer = logsTextBlock?.Parent as ScrollViewer;
                
                if (scrollViewer != null)
                {
                    // Scroll to the bottom
                    scrollViewer.ScrollToEnd();
                }
            }, DispatcherPriority.Background);
        }
    }

    protected override void OnClosing(WindowClosingEventArgs e)
    {
        // Clean up ViewModel subscription
        if (_viewModel != null)
        {
            _viewModel.PropertyChanged -= OnViewModelPropertyChanged;
            _viewModel.Dispose();
        }
        
        base.OnClosing(e);
    }
}