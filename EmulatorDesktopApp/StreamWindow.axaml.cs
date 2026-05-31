using System;
using System.ComponentModel;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using EmulatorDesktopApp.ViewModels;

namespace EmulatorDesktopApp;

public partial class StreamWindow : Window
{
    private const double ToolbarWidth = 56;
    private const double MirrorToolbarDivider = 1;
    private const double DefaultVideoWidth = 360;
    private static readonly Size DefaultVideoAspect = new(720, 1280);

    private StreamWindowViewModel? _viewModel;
    private bool _sizeInitialized;
    private double _appBarHeight = 52;

    public StreamWindow()
    {
        InitializeComponent();
        AddHandler(PointerPressedEvent, OnPointerPressed, handledEventsToo: true);
        AddHandler(PointerReleasedEvent, OnPointerReleased, handledEventsToo: true);
        KeyDown += OnKeyDown;
        DataContextChanged += OnDataContextChanged;
        Opened += OnOpened;
    }

    private void OnDataContextChanged(object? sender, EventArgs e)
    {
        if (_viewModel != null)
        {
            _viewModel.PropertyChanged -= OnViewModelPropertyChanged;
            _viewModel.RequestFullscreenToggle = null;
        }

        _viewModel = DataContext as StreamWindowViewModel;
        if (_viewModel == null)
            return;

        _viewModel.PropertyChanged += OnViewModelPropertyChanged;
        _viewModel.RequestFullscreenToggle = ToggleFullscreen;
    }

    private void OnOpened(object? sender, EventArgs e)
    {
        LayoutUpdated += OnInitialLayoutUpdated;
    }

    private void OnInitialLayoutUpdated(object? sender, EventArgs e)
    {
        if (AppBar.Bounds.Height <= 0)
            return;

        LayoutUpdated -= OnInitialLayoutUpdated;
        _appBarHeight = AppBar.Bounds.Height;
        ApplyCompactSize(DefaultVideoAspect);
    }

    private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName != nameof(StreamWindowViewModel.CurrentFrame) || _viewModel?.CurrentFrame == null)
            return;

        if (_sizeInitialized)
            return;

        var ps = _viewModel.CurrentFrame.PixelSize;
        if (ps.Width <= 0 || ps.Height <= 0)
            return;

        _sizeInitialized = true;
        ApplyCompactSize(new Size(ps.Width, ps.Height));
    }

    /// <summary>
    /// Fit the window to portrait video + toolbar so there is no side letterboxing.
    /// </summary>
    private void ApplyCompactSize(Size videoPixelSize)
    {
        if (_viewModel?.IsFullscreen == true)
            return;

        if (AppBar.Bounds.Height > 0)
            _appBarHeight = AppBar.Bounds.Height;

        double aspect = videoPixelSize.Height / videoPixelSize.Width;
        double videoWidth = DefaultVideoWidth;
        double videoHeight = videoWidth * aspect;

        VideoColumn.Width = videoWidth;
        Width = videoWidth + MirrorToolbarDivider + ToolbarWidth;
        Height = _appBarHeight + videoHeight;
    }

    private void ToggleFullscreen()
    {
        if (_viewModel == null)
            return;

        if (WindowState == WindowState.FullScreen)
        {
            WindowState = WindowState.Normal;
            _viewModel.IsFullscreen = false;

            if (_viewModel.CurrentFrame != null)
            {
                var ps = _viewModel.CurrentFrame.PixelSize;
                ApplyCompactSize(new Size(ps.Width, ps.Height));
            }
            else
            {
                ApplyCompactSize(DefaultVideoAspect);
            }
        }
        else
        {
            WindowState = WindowState.FullScreen;
            _viewModel.IsFullscreen = true;
        }
    }

    private async void OnKeyDown(object? sender, KeyEventArgs e)
    {
        if (DataContext is not StreamWindowViewModel vm)
            return;

        string? keyCode = e.Key switch
        {
            Key.Back => "KEYCODE_BACK",
            Key.Home => "KEYCODE_HOME",
            Key.Escape => "KEYCODE_BACK",
            Key.Enter => "KEYCODE_ENTER",
            _ => null
        };

        if (keyCode != null)
        {
            await vm.SendRemoteKeyAsync(keyCode);
            e.Handled = true;
        }
    }

    public void InvalidateVideoFrame()
    {
        VideoImage?.InvalidateVisual();
    }

    private static Size GetVideoFrameSize(StreamWindowViewModel vm)
    {
        var pixelSize = vm.CurrentFrame?.PixelSize ?? default;
        return pixelSize.Width > 0 && pixelSize.Height > 0
            ? new Size(pixelSize.Width, pixelSize.Height)
            : default;
    }

    private async void OnPointerPressed(object? sender, PointerPressedEventArgs e)
    {
        if (DataContext is not StreamWindowViewModel vm)
            return;

        if (VideoSurface == null)
            return;

        var pos = e.GetPosition(VideoSurface);
        var size = VideoSurface.Bounds.Size;
        if (size.Width <= 0 || size.Height <= 0)
            return;

        await vm.HandlePointerPressedAsync(pos, size, GetVideoFrameSize(vm));
        e.Handled = true;
    }

    private async void OnPointerReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (DataContext is not StreamWindowViewModel vm)
            return;

        if (VideoSurface == null)
            return;

        var pos = e.GetPosition(VideoSurface);
        var size = VideoSurface.Bounds.Size;
        if (size.Width <= 0 || size.Height <= 0)
            return;

        await vm.HandlePointerReleasedAsync(pos, size, GetVideoFrameSize(vm));
        e.Handled = true;
    }

    protected override void OnClosed(EventArgs e)
    {
        if (_viewModel != null)
        {
            _viewModel.PropertyChanged -= OnViewModelPropertyChanged;
            _viewModel.RequestFullscreenToggle = null;
        }

        base.OnClosed(e);
    }
}
