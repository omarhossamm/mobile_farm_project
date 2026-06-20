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
    private const double DefaultVideoWidth = 400;
    private static readonly Size DefaultVideoAspect = new(720, 1280);

    // iOS Simulator viewer geometry. The screen has a fixed width; height is
    // derived from the streamed aspect. The window grows by the bezel + device
    // margin (both sides) plus the chrome header. These mirror StreamWindow.axaml
    // (Border padding 13 + border 5 = 18 bezel; device Margin 20; header 46).
    private const double IosScreenWidth = 300;
    private const double IosHorizontalExtra = 76;   // 2 * (18 bezel + 20 margin)
    private const double IosVerticalExtra = 122;    // 46 header + 2 * (18 + 20)
    private static readonly Size DefaultIosAspect = new(393, 852);

    private StreamWindowViewModel? _viewModel;
    private bool _sizeInitialized;
    private double _appBarHeight = 52;
    private bool _closingAfterStop;
    private bool _isClosing;

    public StreamWindow()
    {
        InitializeComponent();
        WireVideoSurfacePointerHandlers(VideoSurface);
        WireVideoSurfacePointerHandlers(IosVideoSurface);
        KeyDown += OnKeyDown;
        TextInput += OnTextInput;
        DataContextChanged += OnDataContextChanged;
        Opened += OnOpened;
    }

    private void WireVideoSurfacePointerHandlers(Border surface)
    {
        surface.PointerPressed += OnVideoPointerPressed;
        surface.PointerMoved += OnVideoPointerMoved;
        surface.PointerReleased += OnVideoPointerReleased;
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
        Focus();
        LayoutUpdated += OnInitialLayoutUpdated;
    }

    private void OnInitialLayoutUpdated(object? sender, EventArgs e)
    {
        // iOS viewer: no app bar to measure — size immediately from the default
        // iPhone aspect; the first real frame refines it.
        if (_viewModel?.IsIosViewer == true)
        {
            LayoutUpdated -= OnInitialLayoutUpdated;
            ApplyCompactSize(DefaultIosAspect);
            return;
        }

        if (AppBar.Bounds.Height <= 0)
            return;

        LayoutUpdated -= OnInitialLayoutUpdated;
        _appBarHeight = AppBar.Bounds.Height;
        ApplyCompactSize(DefaultVideoAspect);
    }

    // The video surface / image that is actually on screen for the current
    // platform. Android keeps using the original named controls (identical
    // behaviour); iOS uses the device-frame controls.
    private Border? ActiveVideoSurface =>
        _viewModel?.IsIosViewer == true ? IosVideoSurface : VideoSurface;

    private Image? ActiveVideoImage =>
        _viewModel?.IsIosViewer == true ? IosVideoImage : VideoImage;

    private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (_isClosing || _viewModel?.IsShuttingDown == true)
            return;

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

    /// Fit the window to portrait video (video + toolbar / iOS device frame).
    private void ApplyCompactSize(Size videoPixelSize)
    {
        if (_isClosing || _viewModel?.IsShuttingDown == true)
            return;

        if (_viewModel?.IsFullscreen == true)
            return;

        double aspect = videoPixelSize.Height / videoPixelSize.Width;

        // iOS Simulator viewer: size the screen rect inside the device frame and
        // grow the window by the frame chrome. Leaves the Android path untouched.
        if (_viewModel?.IsIosViewer == true)
        {
            double screenW = IosScreenWidth;
            double screenH = screenW * aspect;
            IosVideoSurface.Width = screenW;
            IosVideoSurface.Height = screenH;
            Width = screenW + IosHorizontalExtra;
            Height = screenH + IosVerticalExtra;
            return;
        }

        if (AppBar.Bounds.Height > 0)
            _appBarHeight = AppBar.Bounds.Height;

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
                ApplyCompactSize(_viewModel.IsIosViewer ? DefaultIosAspect : DefaultVideoAspect);
            }
        }
        else
        {
            WindowState = WindowState.FullScreen;
            _viewModel.IsFullscreen = true;
        }
    }

    private async void OnTextInput(object? sender, TextInputEventArgs e)
    {
        if (DataContext is not StreamWindowViewModel vm || !vm.HasVideoFrame)
            return;

        if (string.IsNullOrEmpty(e.Text))
            return;

        if (e.Text is "\r" or "\n" or "\r\n")
            await vm.SendRemoteKeyAsync("KEYCODE_ENTER");
        else
            await vm.SendRemoteTextAsync(e.Text);

        e.Handled = true;
    }

    private async void OnKeyDown(object? sender, KeyEventArgs e)
    {
        if (DataContext is not StreamWindowViewModel vm || !vm.HasVideoFrame)
            return;

        if (HasBlockingModifier(e.KeyModifiers))
            return;

        string? keyCode = e.Key switch
        {
            Key.Back => "KEYCODE_DEL",
            Key.Delete => "KEYCODE_FORWARD_DEL",
            Key.Enter => "KEYCODE_ENTER",
            Key.Tab => "KEYCODE_TAB",
            Key.Escape => "KEYCODE_BACK",
            Key.Home => "KEYCODE_HOME",
            _ => null
        };

        if (keyCode != null)
        {
            await vm.SendRemoteKeyAsync(keyCode);
            e.Handled = true;
        }
    }

    private static bool HasBlockingModifier(KeyModifiers modifiers) =>
        modifiers.HasFlag(KeyModifiers.Control) ||
        modifiers.HasFlag(KeyModifiers.Alt) ||
        modifiers.HasFlag(KeyModifiers.Meta);

    public void InvalidateVideoFrame()
    {
        ActiveVideoImage?.InvalidateVisual();
    }

    private static Size GetVideoFrameSize(StreamWindowViewModel vm)
    {
        var pixelSize = vm.CurrentFrame?.PixelSize ?? default;
        return pixelSize.Width > 0 && pixelSize.Height > 0
            ? new Size(pixelSize.Width, pixelSize.Height)
            : default;
    }

    private async void OnVideoPointerPressed(object? sender, PointerPressedEventArgs e)
    {
        if (sender is not Border surface || DataContext is not StreamWindowViewModel vm)
            return;

        Focus();

        var pos = e.GetPosition(surface);
        var size = surface.Bounds.Size;
        if (size.Width <= 0 || size.Height <= 0)
            return;

        await vm.HandlePointerPressedAsync(pos, size, GetVideoFrameSize(vm));
        e.Pointer.Capture(surface);
        e.Handled = true;
    }

    private async void OnVideoPointerMoved(object? sender, PointerEventArgs e)
    {
        if (sender is not Border surface || DataContext is not StreamWindowViewModel vm || !vm.IsIosViewer)
            return;

        var pos = e.GetPosition(surface);
        var size = surface.Bounds.Size;
        if (size.Width <= 0 || size.Height <= 0)
            return;

        await vm.HandlePointerMovedAsync(pos, size, GetVideoFrameSize(vm));
    }

    private async void OnVideoPointerReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (sender is not Border surface || DataContext is not StreamWindowViewModel vm)
            return;

        var pos = e.GetPosition(surface);
        var size = surface.Bounds.Size;
        if (size.Width <= 0 || size.Height <= 0)
            return;

        await vm.HandlePointerReleasedAsync(pos, size, GetVideoFrameSize(vm));
        e.Pointer.Capture(null);
        e.Handled = true;
    }

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);

        if (change.Property != WindowStateProperty || _viewModel == null)
            return;

        if (WindowState == WindowState.Normal && _viewModel.IsFullscreen)
        {
            _viewModel.IsFullscreen = false;
            if (_viewModel.CurrentFrame != null)
            {
                var ps = _viewModel.CurrentFrame.PixelSize;
                ApplyCompactSize(new Size(ps.Width, ps.Height));
            }
            else
            {
                ApplyCompactSize(_viewModel.IsIosViewer ? DefaultIosAspect : DefaultVideoAspect);
            }
        }
    }

    protected override async void OnClosing(WindowClosingEventArgs e)
    {
        _isClosing = true;

        if (_closingAfterStop)
        {
            _viewModel?.StopMetricsTimer();
            base.OnClosing(e);
            return;
        }

        if (_viewModel?.ShouldStopStreamOnClose == true)
        {
            e.Cancel = true;
            await _viewModel.StopStreamOnWindowCloseAsync();
            _closingAfterStop = true;
            Close();
            return;
        }

        _viewModel?.StopMetricsTimer();
        base.OnClosing(e);
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
