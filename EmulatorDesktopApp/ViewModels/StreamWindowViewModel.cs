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
        private Point? _swipeStart;
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
            HomeCommand       = new AsyncRelayCommand(() => SendKey("KEYCODE_HOME"),        () => HasVideoFrame);
            RecentAppsCommand = new AsyncRelayCommand(() => SendKey("KEYCODE_APP_SWITCH"),  () => HasVideoFrame);
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

        /// <summary>
        /// Primary header line — device id (or fallback label).
        /// </summary>
        public string DeviceLabel
        {
            get
            {
                var device = _mainViewModel.SelectedDevice;
                return string.IsNullOrEmpty(device) ? "Android Emulator" : device;
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

        /// <summary>
        /// Window title shown in the custom title bar. Mirrors the
        /// "Android Emulator — &lt;device&gt;" format the official emulator uses.
        /// </summary>
        public string WindowTitle
        {
            get
            {
                var device = _mainViewModel.SelectedDevice;
                return string.IsNullOrEmpty(device)
                    ? "Android Emulator"
                    : $"Android Emulator — {device}";
            }
        }

        /// <summary>
        /// Small gray subtitle rendered above <see cref="StreamStatus"/> in the
        /// stream-window header. Shows the device id and a short session id so
        /// the user can tell which emulator / session the mirror window is
        /// bound to at a glance. Derived from the parent
        /// <see cref="MainWindowViewModel"/>; both fields are stable for the
        /// lifetime of the stream window, so no change notification is needed
        /// (the window is closed and recreated on stop / restart).
        /// </summary>
        public string SessionLabel
        {
            get
            {
                var device = _mainViewModel.SelectedDevice;
                var sessionId = _mainViewModel.SessionId;
                var shortSession = string.IsNullOrEmpty(sessionId)
                    ? string.Empty
                    : (sessionId.Length > 8 ? sessionId.Substring(0, 8) : sessionId);

                if (string.IsNullOrEmpty(device) && string.IsNullOrEmpty(shortSession))
                    return "No active session";
                if (string.IsNullOrEmpty(shortSession))
                    return device!;
                if (string.IsNullOrEmpty(device))
                    return $"Session {shortSession}";
                return $"{device} · session {shortSession}";
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

        /// <summary>
        /// Pushes a freshly-written bitmap to the view. The render pipeline rotates
        /// between two bitmaps so this is always a different reference and Avalonia
        /// is forced to re-bind + re-upload.
        /// </summary>
        public void UpdateFrame(WriteableBitmap frame)
        {
            CurrentFrame = frame;
            OnFrameUpdated?.Invoke();
        }

        public void UpdateStatus(string status) => StreamStatus = status;

        // ── Pointer mapping ───────────────────────────────────────────────────
        //
        // VideoImage uses Stretch="Uniform" — the picture is letterboxed inside
        // VideoSurface. Normalizing against the full surface shifts taps toward
        // the centre and makes the device hit the wrong list item.

        public Task HandlePointerPressedAsync(Point position, Size viewSize, Size videoSize)
        {
            if (TryNormalize(position, viewSize, videoSize, out var nx, out var ny))
                _swipeStart = new Point(nx, ny);
            return Task.CompletedTask;
        }

        public async Task HandlePointerReleasedAsync(Point position, Size viewSize, Size videoSize)
        {
            if (_swipeStart is not { } start)
                return;

            if (!TryNormalize(position, viewSize, videoSize, out var nx, out var ny))
            {
                _swipeStart = null;
                return;
            }

            double dx = nx - start.X;
            double dy = ny - start.Y;
            double dist = Math.Sqrt(dx * dx + dy * dy);

            if (dist > 0.02)
                await _mainViewModel.SendRemoteSwipeAsync(start.X, start.Y, nx, ny);
            else
                await _mainViewModel.SendRemoteTapAsync(nx, ny);

            _swipeStart = null;
        }

        internal static bool TryNormalize(
            Point position,
            Size viewSize,
            Size videoSize,
            out double nx,
            out double ny)
        {
            nx = ny = 0;
            if (viewSize.Width <= 0 || viewSize.Height <= 0)
                return false;

            if (videoSize.Width <= 0 || videoSize.Height <= 0)
            {
                nx = Math.Clamp(position.X / viewSize.Width, 0, 1);
                ny = Math.Clamp(position.Y / viewSize.Height, 0, 1);
                return true;
            }

            if (!TryGetUniformContentRect(viewSize, videoSize, out var contentRect))
                return false;

            if (!contentRect.Contains(position))
                return false;

            nx = Math.Clamp((position.X - contentRect.X) / contentRect.Width, 0, 1);
            ny = Math.Clamp((position.Y - contentRect.Y) / contentRect.Height, 0, 1);
            return true;
        }

        internal static bool TryGetUniformContentRect(Size viewSize, Size videoSize, out Rect contentRect)
        {
            contentRect = default;
            if (viewSize.Width <= 0 || viewSize.Height <= 0 ||
                videoSize.Width <= 0 || videoSize.Height <= 0)
            {
                return false;
            }

            double videoAspect = videoSize.Width / videoSize.Height;
            double viewAspect = viewSize.Width / viewSize.Height;

            double contentWidth;
            double contentHeight;
            if (viewAspect > videoAspect)
            {
                contentHeight = viewSize.Height;
                contentWidth = contentHeight * videoAspect;
            }
            else
            {
                contentWidth = viewSize.Width;
                contentHeight = contentWidth / videoAspect;
            }

            double offsetX = (viewSize.Width - contentWidth) / 2;
            double offsetY = (viewSize.Height - contentHeight) / 2;
            contentRect = new Rect(offsetX, offsetY, contentWidth, contentHeight);
            return true;
        }

        public Task SendRemoteKeyAsync(string keyCode) => _mainViewModel.SendRemoteKeyAsync(keyCode);

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
