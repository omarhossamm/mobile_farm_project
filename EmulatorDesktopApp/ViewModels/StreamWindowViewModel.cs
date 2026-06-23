using Avalonia;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using EmulatorDesktopApp.Services;
using EmulatorDesktopApp.ViewModels.Commands;
using System;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using System.Windows.Input;

namespace EmulatorDesktopApp.ViewModels
{
    /// <summary>
    /// ViewModel for the dedicated live-mirror window. Exposes all the device
    /// controls a real Android emulator window offers (power, volume, navigation,
    /// rotate, screenshot, fullscreen).
    /// </summary>
    public class StreamWindowViewModel : INotifyPropertyChanged
    {
        private readonly MainWindowViewModel _mainViewModel;
        private WriteableBitmap? _currentFrame;
        private string _streamStatus = "Connecting...";
        private bool _hasVideoFrame;
        private bool _isVideoStalled;
        private Point? _swipeStart;
        private DateTime _pointerDownUtc;
        private readonly IosHomeIndicatorGestureRecognizer _iosHomeGesture = new();
        private string _metricsText = string.Empty;
        private DispatcherTimer? _metricsTimer;
        private bool _isFullscreen;

        public StreamWindowViewModel(MainWindowViewModel mainViewModel)
        {
            _mainViewModel = mainViewModel ?? throw new ArgumentNullException(nameof(mainViewModel));

            // Device-side commands — disabled until the stream is actually running.
            PowerCommand      = new AsyncRelayCommand(() => SendKey("KEYCODE_POWER"),       () => HasVideoFrame);
            VolumeUpCommand   = new AsyncRelayCommand(() => SendKey("KEYCODE_VOLUME_UP"),   () => HasVideoFrame);
            VolumeDownCommand = new AsyncRelayCommand(() => SendKey("KEYCODE_VOLUME_DOWN"), () => HasVideoFrame);
            BackCommand       = new AsyncRelayCommand(() => SendKey("KEYCODE_BACK"),        () => HasVideoFrame);
            HomeCommand         = new AsyncRelayCommand(() => SendKey("KEYCODE_HOME"),        () => HasVideoFrame);
            RecentAppsCommand   = new AsyncRelayCommand(() => SendKey("KEYCODE_APP_SWITCH"),  () => HasVideoFrame);
            ScreenshotCommand = new AsyncRelayCommand(TakeScreenshotAsync,                  () => HasVideoFrame);

            // Window / client-side commands — always enabled.
            FullscreenCommand = new RelayCommand(() => RequestFullscreenToggle?.Invoke());

            StopStreamCommand = new AsyncRelayCommand(StopStreamAsync);

            StartMetricsTimer();
        }

        // ── Window-control hooks ──────────────────────────────────────────────
        //
        // The ViewModel cannot manipulate Window.WindowState directly without
        // leaking Window references into the VM. We expose a simple callback
        // that the code-behind wires up — keeps the VM unit-testable.

        public Action? RequestFullscreenToggle { get; set; }

        // ── Bindable state ────────────────────────────────────────────────────

        public string MetricsText
        {
            get => _metricsText;
            private set
            {
                if (_metricsText == value) return;
                _metricsText = value;
                OnPropertyChanged();
            }
        }

        public WriteableBitmap? CurrentFrame
        {
            get => _currentFrame;
            set
            {
                if (_currentFrame == value) return;
                _currentFrame = value;
                HasVideoFrame = value != null;
                OnPropertyChanged();
            }
        }

        public bool HasVideoFrame
        {
            get => _hasVideoFrame;
            private set
            {
                if (_hasVideoFrame == value) return;
                _hasVideoFrame = value;
                OnPropertyChanged();
                OnPropertyChanged(nameof(ShowVideoPlaceholder));
                RefreshDeviceCommandStates();
            }
        }

        public bool ShowVideoPlaceholder => !HasVideoFrame;

        public string StreamStatus
        {
            get => _streamStatus;
            set
            {
                if (_streamStatus == value) return;
                _streamStatus = value;
                OnPropertyChanged();
            }
        }

        /// <summary>
        /// True while the server-side capture pipe is stalled (no frames for 500 ms+).
        /// Drives a "buffering" overlay in the view so the user sees a spinner
        /// rather than a silently frozen frame.
        /// </summary>
        public bool IsVideoStalled
        {
            get => _isVideoStalled;
            private set
            {
                if (_isVideoStalled == value) return;
                _isVideoStalled = value;
                OnPropertyChanged();
            }
        }

        public bool IsFullscreen
        {
            get => _isFullscreen;
            set
            {
                if (_isFullscreen == value) return;
                _isFullscreen = value;
                OnPropertyChanged();
            }
        }

        public MainWindowViewModel MainViewModel => _mainViewModel;

    // ── Platform-specific viewer selection ──────────────────────────────────
    //
    // The iOS Simulator viewer (device frame + Simulator chrome) is an entirely
    // separate presentation path from the Android viewer. Platform is taken from
    // the selected device (stable for the lifetime of this window), so the
    // correct viewer is chosen before the first frame arrives. Android keeps its
    // exact previous behaviour (IsIosViewer == false → identical bindings).

    public bool IsIosViewer =>
        string.Equals(_mainViewModel.SelectedDevice?.Platform, "ios", StringComparison.OrdinalIgnoreCase)
        || string.Equals(_mainViewModel.CoordinateMapper.Meta?.Platform, "ios", StringComparison.OrdinalIgnoreCase);

    /// <summary>Android viewer (video column + side toolbar) visibility.</summary>
    public bool ShowAndroidViewer => !IsIosViewer;

    // Android: side toolbar always shown (unchanged). iOS: hidden — the iOS
    // viewer uses Simulator-style chrome instead.
    public bool ShowSideToolbar => !IsIosViewer;

    /// <summary>Model name shown in the iOS Simulator chrome header.</summary>
    public string IosDeviceName
    {
        get
        {
            var device = _mainViewModel.SelectedDevice;
            if (device != null && !string.IsNullOrEmpty(device.DisplayName))
                return device.DisplayName;
            var id = _mainViewModel.SelectedDeviceId;
            return string.IsNullOrEmpty(id) ? "iPhone" : id;
        }
    }

    /// <summary>Secondary line in the iOS chrome header.</summary>
    public string IosRuntimeLabel => "iOS Simulator";

    public bool IsIpadViewer
    {
        get
        {
            var device = _mainViewModel.SelectedDevice;
            if (!IsIosViewer || device == null)
                return false;

            if (!string.IsNullOrEmpty(device.DeviceTypeIdentifier) &&
                device.DeviceTypeIdentifier.Contains("iPad", StringComparison.OrdinalIgnoreCase))
                return true;

            return device.DisplayName?.Contains("iPad", StringComparison.OrdinalIgnoreCase) == true;
        }
    }

    public string DeviceLabel
    {
        get
        {
            var device = _mainViewModel.SelectedDevice;
            if (device != null && !string.IsNullOrEmpty(device.DisplayName))
                return device.DisplayName;
            var id = _mainViewModel.SelectedDeviceId;
            if (!string.IsNullOrEmpty(id))
                return id;
            return IsIosViewer ? "iOS Simulator" : "Android Emulator";
        }
    }

    // Screen rounded-corner radius for the iOS device-frame viewer. Updated by
    // StreamWindow.ApplyCompactSize() so the radius scales with the actual
    // rendered screen rect, keeping the rounded screen edge proportional and
    // matching the bezel inner curve for both iPhone and iPad simulators.
    //
    // NOTE: type is Avalonia.CornerRadius (not double) so the XAML binding to
    // Border.CornerRadius resolves directly — runtime bindings do not invoke
    // the XAML-time double→CornerRadius type converter, which is why a double
    // property would silently fall back to the default zero-radius corners and
    // let the rectangular image poke out past the bezel.
    private Avalonia.CornerRadius _iosFrameCornerRadius = new(34);
    public Avalonia.CornerRadius IosFrameCornerRadius
    {
        get => _iosFrameCornerRadius;
        set
        {
            if (_iosFrameCornerRadius.Equals(value)) return;
            _iosFrameCornerRadius = value;
            OnPropertyChanged();
        }
    }

        /// <summary>
        /// Short session id for the second header line.
        /// </summary>
        public string SessionHint
        {
            get
            {
                var sessionId = _mainViewModel.SessionId;
                if (string.IsNullOrEmpty(sessionId))
                    return string.Empty;

                var shortSession = sessionId.Length > 8 ? sessionId.Substring(0, 8) : sessionId;
                return $"session {shortSession}";
            }
        }

        public string WindowTitle
        {
            get
            {
                var device = _mainViewModel.SelectedDevice;
                var label = device?.DisplayName ?? _mainViewModel.SelectedDeviceId;
                if (IsIosViewer)
                    return string.IsNullOrEmpty(label) ? "iOS Simulator" : $"iOS Simulator — {label}";
                return string.IsNullOrEmpty(label) ? "Android Emulator" : $"Android Emulator — {label}";
            }
        }

        // ── Commands ──────────────────────────────────────────────────────────

        public ICommand StopStreamCommand { get; }

        public ICommand PowerCommand      { get; }
        public ICommand VolumeUpCommand   { get; }
        public ICommand VolumeDownCommand { get; }
        public ICommand BackCommand       { get; }
        public ICommand HomeCommand       { get; }
        public ICommand RecentAppsCommand { get; }
        public ICommand ScreenshotCommand { get; }

        public ICommand FullscreenCommand { get; }

        // ── Frame plumbing ────────────────────────────────────────────────────

        /// <summary>Called after pixels are written so the view can InvalidateVisual.</summary>
        public Action? OnFrameUpdated { get; set; }

        public bool IsShuttingDown { get; private set; }

        /// <summary>Stop frame delivery before the mirror window is closed.</summary>
        public void BeginShutdown()
        {
            if (IsShuttingDown)
                return;

            IsShuttingDown = true;
            OnFrameUpdated = null;
            CurrentFrame = null;
            IsVideoStalled = false;
        }

        /// <summary>
        /// Pushes a freshly-written bitmap to the view. The render pipeline rotates
        /// between two bitmaps so this is always a different reference and Avalonia
        /// is forced to re-bind + re-upload.
        /// </summary>
        public void UpdateFrame(WriteableBitmap frame)
        {
            if (IsShuttingDown)
                return;

            CurrentFrame = frame;
            OnFrameUpdated?.Invoke();
        }

        public void UpdateStatus(string status) => StreamStatus = status;

        /// <summary>Shown when the server signals no frames have been sent for 500 ms+.</summary>
        public void NotifyStall() => IsVideoStalled = true;

        /// <summary>Clears the stall indicator when frame delivery resumes.</summary>
        public void NotifyStallCleared() => IsVideoStalled = false;

        // ── Pointer mapping ───────────────────────────────────────────────────
        //
        // Android StreamWindow uses Stretch="Uniform" and letterbox-aware mapping.

        public Task HandlePointerPressedAsync(Point position, Size viewSize, Size videoSize)
        {
            _pointerDownUtc = DateTime.UtcNow;
            _iosHomeGesture.Reset();

            if (_mainViewModel.CoordinateMapper.TryNormalize(
                    position, viewSize, videoSize, out var nx, out var ny))
            {
                _swipeStart = new Point(nx, ny);
                if (IsIosViewer)
                    _iosHomeGesture.Begin(nx, ny);
            }

            return Task.CompletedTask;
        }

        public async Task HandlePointerMovedAsync(Point position, Size viewSize, Size videoSize)
        {
            if (!IsIosViewer || !_iosHomeGesture.IsActive || _iosHomeGesture.IsConsumed)
                return;

            if (!_mainViewModel.CoordinateMapper.TryNormalize(position, viewSize, videoSize, out var nx, out var ny))
                return;

            if (_iosHomeGesture.Update(nx, ny) == IosHomeIndicatorGestureRecognizer.GestureAction.AppSwitcher)
                await _mainViewModel.SendRemoteAppSwitcherAsync();
        }

        public async Task HandlePointerReleasedAsync(Point position, Size viewSize, Size videoSize)
        {
            if (_swipeStart is not { } start)
                return;

            if (!_mainViewModel.CoordinateMapper.TryNormalize(position, viewSize, videoSize, out var nx, out var ny))
            {
                _swipeStart = null;
                _iosHomeGesture.Reset();
                return;
            }

            int gestureMs = (int)Math.Max(0, (DateTime.UtcNow - _pointerDownUtc).TotalMilliseconds);

            if (IsIosViewer && !_iosHomeGesture.IsConsumed)
            {
                var action = _iosHomeGesture.Complete(nx, ny, gestureMs);
                if (action == IosHomeIndicatorGestureRecognizer.GestureAction.AppSwitcher)
                {
                    await _mainViewModel.SendRemoteAppSwitcherAsync();
                    _swipeStart = null;
                    _iosHomeGesture.Reset();
                    return;
                }

                if (action == IosHomeIndicatorGestureRecognizer.GestureAction.Home)
                {
                    await _mainViewModel.SendRemoteKeyAsync("KEYCODE_HOME");
                    _swipeStart = null;
                    _iosHomeGesture.Reset();
                    return;
                }
            }

            if (IsIosViewer && _iosHomeGesture.IsConsumed)
            {
                _swipeStart = null;
                _iosHomeGesture.Reset();
                return;
            }

            double dx = nx - start.X;
            double dy = ny - start.Y;
            double dist = Math.Sqrt(dx * dx + dy * dy);

            if (dist > 0.02)
                await _mainViewModel.SendRemoteSwipeAsync(start.X, start.Y, nx, ny);
            else
                await _mainViewModel.SendRemoteTapAsync(start.X, start.Y);

            _swipeStart = null;
            _iosHomeGesture.Reset();
        }

        public Task SendRemoteKeyAsync(string keyCode) => _mainViewModel.SendRemoteKeyAsync(keyCode);

        public Task SendRemoteTextAsync(string text) => _mainViewModel.SendRemoteTextAsync(text);

        public void NotifyFrameRendered() => _mainViewModel.StreamMetrics.RecordRendered();

        // ── Device-control helpers ────────────────────────────────────────────

        private Task SendKey(string keyCode) => _mainViewModel.SendRemoteKeyAsync(keyCode);

        /// <summary>
        /// Save a screenshot to the user's Desktop folder. The gateway's
        /// `screenshot` handler runs `adb shell screencap -p /sdcard/screenshot.png`
        /// followed by `adb pull` to <c>local_path</c>, so the file lands on
        /// whichever host runs the rack-agent — the desktop machine in the
        /// typical single-host dev setup.
        /// </summary>
        private Task TakeScreenshotAsync()
        {
            var fileName = $"emustream_{DateTime.Now:yyyyMMdd_HHmmss}.png";
            var desktop  = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            // Fall back to the user's home if SpecialFolder returns empty on this OS.
            if (string.IsNullOrWhiteSpace(desktop))
                desktop = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var fullPath = System.IO.Path.Combine(desktop, fileName);
            return _mainViewModel.SendScreenshotAsync(fullPath);
        }

        // ── Metrics & lifecycle ───────────────────────────────────────────────

        private void StartMetricsTimer()
        {
            _metricsTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            _metricsTimer.Tick += (_, _) =>
            {
                var (decodeFps, renderFps, dropped) = _mainViewModel.StreamMetrics.SampleAndReset();
                MetricsText = $"Decode {decodeFps:F0} fps · Render {renderFps:F0} fps · Dropped {dropped}";
            };
            _metricsTimer.Start();
        }

        public void StopMetricsTimer()
        {
            _metricsTimer?.Stop();
            _metricsTimer = null;
        }

        private async Task StopStreamAsync() =>
            await _mainViewModel.StopStreamFromStreamWindowAsync();

        public bool ShouldStopStreamOnClose =>
            !_mainViewModel.SuppressStopOnStreamWindowClose && _mainViewModel.IsStreaming;

        public Task StopStreamOnWindowCloseAsync() =>
            _mainViewModel.StopStreamWithoutClosingWindowAsync();

        private void RefreshDeviceCommandStates()
        {
            (PowerCommand      as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (VolumeUpCommand   as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (VolumeDownCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (BackCommand       as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (HomeCommand       as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (RecentAppsCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (ScreenshotCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        }

        public event PropertyChangedEventHandler? PropertyChanged;

        protected void OnPropertyChanged([CallerMemberName] string? propertyName = null) =>
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }
}
