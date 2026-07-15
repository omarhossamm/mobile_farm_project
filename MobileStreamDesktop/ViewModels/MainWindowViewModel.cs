using Avalonia;
using Avalonia.Threading;
using System.Threading;
using MobileStreamDesktop.Services;
using MobileStreamDesktop.Streaming;
using MobileStreamDesktop.ViewModels.Commands;
using System;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Input;

namespace MobileStreamDesktop.ViewModels
{
    /// <summary>
    /// ViewModel for the main window, implementing MVVM pattern.
    /// Handles UI bindings and orchestrates WebSocket communication.
    /// </summary>
    public class MainWindowViewModel : INotifyPropertyChanged, IDisposable
    {
        private readonly WebSocketService _webSocketService;
        private readonly MirrorSession _mirror;
        private readonly RemoteControlService _remoteControl;
        public StreamMetrics StreamMetrics { get; } = new();
        private readonly Action<StreamWindowViewModel>? _openStreamWindow;
        private readonly Action? _closeStreamWindow;
        private StreamWindowViewModel? _streamWindowViewModel;
        private string _webSocketUrl = "ws://localhost:8080";
        // Logs panel is a bounded ring buffer so AppendLog stays O(1) instead
        // of the historical O(N²) (`Logs = Logs + Environment.NewLine + line`)
        // that would re-render the entire bound text widget on every append.
        // 32 KB is enough for a few hundred lines of diagnostics while keeping
        // PropertyChanged churn negligible during signaling / scene-cut bursts.
        private const int MaxLogChars = 32 * 1024;
        private const string LogTruncationMarker = "[…truncated…]\n";
        private string _logs = string.Empty;
        private bool _isConnected;
        private bool _isConnecting;
        private bool _disposed;
        private DeviceOption? _selectedDevice;
        private string? _pendingSelectDeviceId;
        private string _sessionId = string.Empty;
        private bool _hasDeviceSession;
        private bool _isRefreshingDevices;
        private string _streamStatus = "No stream";
        private bool _isStreaming;
        private bool _ignoreStreamStoppedResponses;
        private bool _suppressStopOnStreamWindowClose;
        private bool _isStoppingStream;
        private string? _sessionBoundDeviceId;
        private string? _sessionBoundAvdName;

        #region Constructor

        public MainWindowViewModel(
            Action<StreamWindowViewModel>? openStreamWindow = null,
            Action? closeStreamWindow = null)
        {
            _openStreamWindow = openStreamWindow;
            _closeStreamWindow = closeStreamWindow;
            _webSocketService = new WebSocketService();
            _mirror = new MirrorSession(AppendLog);
            _remoteControl = new RemoteControlService(_webSocketService);
            _remoteControl.AttachWebRtc(_mirror.WebRtc);

            // Subscribe to WebSocket events
            _webSocketService.OnMessageReceived += HandleMessageReceived;
            _webSocketService.OnConnectionStatusChanged += HandleConnectionStatusChanged;
            _webSocketService.OnError += HandleError;
            _webSocketService.OnLog += HandleLog;

            // Subscribe to WebRTC events
            _mirror.WebRtc.OnStreamStatusChanged += HandleStreamStatusChanged;
            _mirror.WebRtc.OnLog += HandleWebRTCLog;
            _mirror.WebRtc.OnError += HandleWebRTCError;
            _mirror.WebRtc.OnAnswerCreated += HandleAnswerCreated;
            _mirror.WebRtc.OnIceCandidateGenerated += HandleIceCandidateGenerated;
            _mirror.WebRtc.OnDecodedRawFrame = raw =>
            {
                StreamMetrics.RecordDecoded();
                StreamMetrics.RecordQueueDrop((int)_mirror.Render.SkippedBeforeRender);
                _mirror.Render.SubmitDecoded(raw);
            };
            _mirror.WebRtc.OnSceneCut = () =>
            {
                if (_isStoppingStream)
                    return;
                _mirror.Render.OnSceneCut();
            };
            _mirror.WebRtc.OnStreamRecoveryNeeded += HandleStreamRecoveryNeeded;

            // Initialize device collection
            Devices = new ObservableCollection<DeviceOption>();

            // Initialize commands
            ConnectCommand = new AsyncRelayCommand(ExecuteConnectAsync, CanExecuteConnect);
            DisconnectCommand = new AsyncRelayCommand(ExecuteDisconnectAsync, CanExecuteDisconnect);
            RefreshDevicesCommand = new AsyncRelayCommand(ExecuteRefreshDevicesAsync, CanExecuteRefreshDevices);
            CreateSessionCommand = new AsyncRelayCommand(ExecuteCreateSessionAsync, CanExecuteCreateSession);
            DestroySessionCommand = new AsyncRelayCommand(ExecuteDestroySessionAsync, CanExecuteDestroySession);
            StartStreamCommand = new AsyncRelayCommand(ExecuteStartStreamAsync, CanExecuteStartStream);
            StopStreamCommand = new AsyncRelayCommand(ExecuteStopStreamAsync, CanExecuteStopStream);
            ClearLogsCommand = new RelayCommand(ExecuteClearLogs, CanExecuteClearLogs);

            // Add initial log message
            AppendLog("Application started. Enter WebSocket URL and click Connect.");
        }

        #endregion

        #region Properties

        /// <summary>
        /// The WebSocket server URL to connect to.
        /// </summary>
        public string WebSocketUrl
        {
            get => _webSocketUrl;
            set
            {
                if (_webSocketUrl != value)
                {
                    _webSocketUrl = value;
                    OnPropertyChanged();
                    // Refresh command states when URL changes
                    (ConnectCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
                }
            }
        }

        private int _logsNotifyScheduled;

        /// <summary>
        /// The accumulated log messages displayed in the UI.
        /// </summary>
        public string Logs
        {
            get => _logs;
            private set
            {
                if (_logs != value)
                {
                    _logs = value;
                    OnPropertyChanged();
                }
            }
        }

        /// <summary>
        /// Indicates whether the WebSocket is currently connected.
        /// </summary>
        public bool IsConnected
        {
            get => _isConnected;
            private set
            {
                if (_isConnected != value)
                {
                    _isConnected = value;
                    OnPropertyChanged();
                    OnPropertyChanged(nameof(ConnectionStatusText));
                    OnPropertyChanged(nameof(ConnectionStatusColor));
                    // Refresh all command states
                    RefreshAllCommandStates();
                }
            }
        }

        /// <summary>
        /// Indicates whether a connection attempt is in progress.
        /// </summary>
        public bool IsConnecting
        {
            get => _isConnecting;
            private set
            {
                if (_isConnecting != value)
                {
                    _isConnecting = value;
                    OnPropertyChanged();
                    RefreshAllCommandStates();
                }
            }
        }

        /// <summary>
        /// Text representation of the connection status for display.
        /// </summary>
        public string ConnectionStatusText => IsConnected ? "Connected" : "Disconnected";

        /// <summary>
        /// Color indicator for connection status (green for connected, red for disconnected).
        /// </summary>
        public string ConnectionStatusColor => IsConnected ? "#4CAF50" : "#F44336";

        /// <summary>
        /// Collection of all devices from the server (online, offline, and stopped AVDs).
        /// </summary>
        public ObservableCollection<DeviceOption> Devices { get; }

        /// <summary>
        /// The currently selected device from the dropdown.
        /// </summary>
        public DeviceOption? SelectedDevice
        {
            get => _selectedDevice;
            set
            {
                if (!Equals(_selectedDevice, value))
                {
                    _selectedDevice = value;
                    OnPropertyChanged();
                    OnPropertyChanged(nameof(SelectedDeviceId));
                    OnPropertyChanged(nameof(IsSessionDeviceSelected));
                    RaiseSessionCommandCanExecuteChanged();
                }
            }
        }

        /// <summary>
        /// True when no session is active, or the dropdown matches the bound session device.
        /// When false, only Destroy Session should be available.
        /// </summary>
        public bool IsSessionDeviceSelected
        {
            get
            {
                if (!HasDeviceSession || SelectedDevice == null)
                    return true;

                if (!string.IsNullOrEmpty(_sessionBoundDeviceId) &&
                    string.Equals(SelectedDevice.Id, _sessionBoundDeviceId, StringComparison.Ordinal))
                    return true;

                if (!string.IsNullOrEmpty(_sessionBoundAvdName))
                {
                    if (string.Equals(SelectedDevice.AvdName, _sessionBoundAvdName, StringComparison.Ordinal))
                        return true;
                    if (string.Equals(SelectedDevice.Id, _sessionBoundAvdName, StringComparison.Ordinal))
                        return true;
                }

                return false;
            }
        }

        /// <summary>
        /// Device id / AVD name sent to the server when creating a session.
        /// </summary>
        public string? SelectedDeviceId => SelectedDevice?.Id;

        /// <summary>
        /// The current session ID if a session is active.
        /// </summary>
        public string SessionId
        {
            get => _sessionId;
            private set
            {
                if (_sessionId != value)
                {
                    _sessionId = value;
                    OnPropertyChanged();
                    OnPropertyChanged(nameof(SessionStatus));
                    (CreateSessionCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
                    (DestroySessionCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
                    (StartStreamCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
                }
            }
        }

        /// <summary>
        /// True when a device/emulator is bound to the current WebSocket session.
        /// </summary>
        public bool HasDeviceSession
        {
            get => _hasDeviceSession;
            private set
            {
                if (_hasDeviceSession == value)
                    return;

                _hasDeviceSession = value;
                OnPropertyChanged();
                OnPropertyChanged(nameof(SessionStatus));
                OnPropertyChanged(nameof(IsSessionDeviceSelected));
                RaiseSessionCommandCanExecuteChanged();
            }
        }

        /// <summary>Coordinate mapping for the active stream (from stream_meta).</summary>
        public CoordinateMapper CoordinateMapper => _mirror.Coordinates;

        public void UpdateStreamDimensions(int streamW, int streamH) =>
            _mirror.UpdateStreamDimensions(streamW, streamH);

        /// <summary>
        /// Human-readable session status for display (truncated for UI).
        /// </summary>
        public string SessionStatus
        {
            get
            {
                if (!HasDeviceSession || string.IsNullOrEmpty(SessionId))
                    return "No active session";
                
                // Show truncated session ID for compact display
                var shortId = SessionId.Length > 8 ? SessionId.Substring(0, 8) + "..." : SessionId;
                return $"Session: {shortId}";
            }
        }

        /// <summary>
        /// Indicates whether devices are being refreshed.
        /// </summary>
        public bool IsRefreshingDevices
        {
            get => _isRefreshingDevices;
            private set
            {
                if (_isRefreshingDevices != value)
                {
                    _isRefreshingDevices = value;
                    OnPropertyChanged();
                    (RefreshDevicesCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
                }
            }
        }

        /// <summary>
        /// Human-readable stream status for display.
        /// </summary>
        public string StreamStatus
        {
            get => _streamStatus;
            private set
            {
                if (_streamStatus != value)
                {
                    _streamStatus = value;
                    OnPropertyChanged();
                }
            }
        }

        /// <summary>
        /// Indicates whether streaming is currently active.
        /// </summary>
        public bool IsStreaming
        {
            get => _isStreaming;
            private set
            {
                if (_isStreaming != value)
                {
                    _isStreaming = value;
                    OnPropertyChanged();
                    OnPropertyChanged(nameof(StreamStatusColor));
                    (StartStreamCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
                    (StopStreamCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
                }
            }
        }

        /// <summary>
        /// While true, closing the mirror window must not tear down an active stream.
        /// Used when replacing the window during Start Stream.
        /// </summary>
        internal bool SuppressStopOnStreamWindowClose => _suppressStopOnStreamWindowClose;

        /// <summary>
        /// Color for the stream status indicator (green when streaming, red when not).
        /// </summary>
        public Avalonia.Media.Color StreamStatusColor => _isStreaming 
            ? Avalonia.Media.Color.Parse("#4CAF50")  // Green
            : Avalonia.Media.Color.Parse("#F44336"); // Red

        #endregion

        #region Commands

        public ICommand ConnectCommand { get; }
        public ICommand DisconnectCommand { get; }
        public ICommand RefreshDevicesCommand { get; }
        public ICommand CreateSessionCommand { get; }
        public ICommand DestroySessionCommand { get; }
        public ICommand StartStreamCommand { get; }
        public ICommand StopStreamCommand { get; }
        public ICommand ClearLogsCommand { get; }

        #endregion

        #region Command Implementations

        private void RaiseSessionCommandCanExecuteChanged()
        {
            (ConnectCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (DisconnectCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (RefreshDevicesCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (CreateSessionCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (DestroySessionCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (StartStreamCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (StopStreamCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (ClearLogsCommand as RelayCommand)?.RaiseCanExecuteChanged();
        }

        private bool SessionCommandsEnabled => !HasDeviceSession || IsSessionDeviceSelected;

        private bool CanExecuteConnect() =>
            SessionCommandsEnabled && !IsConnected && !IsConnecting && !string.IsNullOrWhiteSpace(WebSocketUrl);

        private async Task ExecuteConnectAsync()
        {
            IsConnecting = true;
            try
            {
                if (IsConnected)
                    await TeardownDeviceSessionAsync("reconnect");
                else
                    ResetLocalSessionState();

                var connected = await _webSocketService.ConnectAsync(WebSocketUrl);
                if (connected)
                {
                    // Auto-fetch device list on successful connection
                    await ExecuteRefreshDevicesAsync();
                }
            }
            finally
            {
                IsConnecting = false;
            }
        }

        private bool CanExecuteDisconnect() => SessionCommandsEnabled && IsConnected && !IsConnecting;

        private async Task ExecuteDisconnectAsync()
        {
            IsConnecting = true;
            try
            {
                await TeardownDeviceSessionAsync("disconnect");
                await _webSocketService.DisconnectAsync();
            }
            finally
            {
                IsConnecting = false;
            }
        }

        private void ExecuteClearLogs()
        {
            if (!CanExecuteClearLogs())
                return;

            Logs = string.Empty;
            AppendLog("Logs cleared");
        }

        private bool CanExecuteClearLogs() => SessionCommandsEnabled;

        private bool CanExecuteRefreshDevices() =>
            SessionCommandsEnabled && IsConnected && !IsRefreshingDevices;

        private async Task ExecuteRefreshDevicesAsync()
        {
            IsRefreshingDevices = true;
            try
            {
                AppendLog("Requesting device list...");
                var message = new { type = "get_devices" };
                var jsonMessage = JsonSerializer.Serialize(message);
                await _webSocketService.SendMessageAsync(jsonMessage);
            }
            finally
            {
                IsRefreshingDevices = false;
            }
        }

        private bool CanExecuteCreateSession() =>
            SessionCommandsEnabled && IsConnected && SelectedDevice != null && !HasDeviceSession;

        private async Task ExecuteCreateSessionAsync()
        {
            if (SelectedDevice == null)
            {
                AppendLog("[ERROR] Please select a device first");
                return;
            }

            if (HasDeviceSession)
            {
                AppendLog("[ERROR] Destroy the current session before creating a new one");
                return;
            }

            if (!SelectedDevice.IsOnline)
            {
                AppendLog($"[INFO] '{SelectedDevice.DisplayName}' is offline — starting on server...");
            }

            AppendLog($"Creating session for device: {SelectedDevice.DisplayName}...");
            var message = new
            {
                type = "create_session",
                device = SelectedDevice.Id
            };

            var jsonMessage = JsonSerializer.Serialize(message);
            var success = await _webSocketService.SendMessageAsync(jsonMessage);

            if (!success)
            {
                AppendLog("Failed to send create session command");
            }
        }

        private bool CanExecuteDestroySession() => IsConnected && HasDeviceSession;

        private async Task ExecuteDestroySessionAsync()
        {
            await TeardownDeviceSessionAsync("manual destroy");
        }

        /// <summary>
        /// Stops any active stream and destroys the bound device session on the server.
        /// </summary>
        private async Task TeardownDeviceSessionAsync(string reason)
        {
            if (IsStreaming)
            {
                AppendLog($"[SESSION] Stopping stream ({reason})...");
                await ExecuteStopStreamAsync();
            }
            else
            {
                CloseStreamWindow();
                ClearStreamBitmap();
            }

            if (!IsConnected)
            {
                HasDeviceSession = false;
                ClearSessionBinding();
                return;
            }

            if (!HasDeviceSession)
                return;

            AppendLog($"[SESSION] Destroying device session ({reason})...");
            var message = new
            {
                type = "destroy_session",
                session_id = SessionId
            };

            var jsonMessage = JsonSerializer.Serialize(message);
            var success = await _webSocketService.SendMessageAsync(jsonMessage);
            if (!success)
                AppendLog("[SESSION] Failed to send destroy session command");

            HasDeviceSession = false;
            ClearSessionBinding();
        }

        private void ClearSessionBinding()
        {
            _sessionBoundDeviceId = null;
            _sessionBoundAvdName = null;
            OnPropertyChanged(nameof(IsSessionDeviceSelected));
            RaiseSessionCommandCanExecuteChanged();
        }

        private void BindSessionDevice(string? deviceId, string? avdName)
        {
            _sessionBoundDeviceId = deviceId;
            _sessionBoundAvdName = avdName;
            OnPropertyChanged(nameof(IsSessionDeviceSelected));
            RaiseSessionCommandCanExecuteChanged();
        }

        private void ResetLocalSessionState()
        {
            if (IsStreaming)
            {
                _mirror.WebRtc.StopStream();
                IsStreaming = false;
                StreamStatus = "No stream";
            }

            ClearStreamBitmap();
            CloseStreamWindow();
            HasDeviceSession = false;
            SessionId = string.Empty;
            ClearSessionBinding();
        }

        private void RefreshAllCommandStates()
        {
            (ConnectCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (DisconnectCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (RefreshDevicesCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (CreateSessionCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (DestroySessionCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (StartStreamCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
            (StopStreamCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        }

        #region Stream Commands

        private bool CanExecuteStartStream() =>
            SessionCommandsEnabled &&
            IsConnected && HasDeviceSession && SelectedDevice?.IsOnline == true && !IsStreaming;

        private async Task ExecuteStartStreamAsync()
        {
            if (!HasDeviceSession || string.IsNullOrEmpty(SessionId))
            {
                AppendLog("[ERROR] Cannot start stream: No active session");
                return;
            }

            if (SelectedDevice?.IsOnline != true)
            {
                AppendLog("[ERROR] Cannot start stream: Device is not online yet");
                return;
            }

            // Ignore stale stream_stopped from a previous session while this start is in flight.
            _ignoreStreamStoppedResponses = true;

            if (IsStreaming)
                await StopStreamWithoutClosingWindowAsync();

            // ── Reset ALL state from the previous stream session ──────────────
            _mirror.ResetForNewStream();
            AppendLog("[STREAM] State reset — starting fresh session");
            // ─────────────────────────────────────────────────────────────────

            AppendLog($"[STREAM] Starting stream for session: {SessionId}...");
            StreamStatus = "Starting...";
            _mirror.WebRtc.SetSignalingRelay(false);

            // Replacing the mirror window must not send stop_stream to the server.
            _suppressStopOnStreamWindowClose = true;
            try
            {
                OpenStreamWindow();
            }
            finally
            {
                _suppressStopOnStreamWindowClose = false;
            }

            await _mirror.WebRtc.PrepareStreamAsync(SessionId);

            var message = WebRTCClient.CreateStartStreamMessage(SessionId, SelectedDeviceId ?? "");
            var success = await _webSocketService.SendMessageAsync(message);

            if (!success)
            {
                _ignoreStreamStoppedResponses = false;
                AppendLog("[ERROR] Failed to send start stream command");
                StreamStatus = "Error";
            }
        }

        private bool CanExecuteStopStream() =>
            SessionCommandsEnabled && IsConnected && IsStreaming;

        private async Task StopStreamCoreAsync()
        {
            if (string.IsNullOrEmpty(SessionId) || !IsStreaming)
                return;

            AppendLog($"[STREAM] Stopping stream for session: {SessionId}...");
            StreamStatus = "Stopping...";

            // Detach the render pipeline before WebRTC teardown so late scene_cut /
            // decode callbacks cannot touch a closing mirror window.
            _streamWindowViewModel?.BeginShutdown();
            await _mirror.DetachStreamWindowAsync();
            ClearStreamBitmap();

            _mirror.WebRtc.SetSignalingRelay(false);

            var message = WebRTCClient.CreateStopStreamMessage(SessionId);
            var success = await _webSocketService.SendMessageAsync(message);

            if (!success)
                AppendLog("[ERROR] Failed to send stop stream command");

            _mirror.WebRtc.StopStream();
            IsStreaming = false;
        }

        private async Task ExecuteStopStreamAsync()
        {
            _isStoppingStream = true;
            try
            {
                await StopStreamCoreAsync();
                CloseStreamWindow(renderAlreadyDetached: true);
            }
            catch (Exception ex)
            {
                AppendLog($"[ERROR] Stop stream failed: {ex.Message}");
            }
            finally
            {
                _isStoppingStream = false;
            }
        }

        /// <summary>Stop an active stream without closing the mirror window.</summary>
        public Task StopStreamWithoutClosingWindowAsync() => StopStreamCoreAsync();

        /// <summary>Called from the stream window Stop button.</summary>
        public Task StopStreamFromStreamWindowAsync() => ExecuteStopStreamAsync();

        private int _streamRecoveryInFlight;

        /// <summary>
        /// Invoked by the WebRTC freeze watchdog when the media path is stuck (user
        /// input produced no video). Rebuilds the WebRTC transport by restarting the
        /// stream on the same session. Guarded so overlapping recoveries and
        /// recoveries during teardown are ignored; the watchdog's own cooldown
        /// prevents rapid re-fire.
        /// </summary>
        private void HandleStreamRecoveryNeeded()
        {
            if (Interlocked.CompareExchange(ref _streamRecoveryInFlight, 1, 0) != 0)
                return;

            Dispatcher.UIThread.Post(async () =>
            {
                try
                {
                    if (_isStoppingStream || !IsStreaming || !IsConnected)
                        return;

                    AppendLog("[STREAM] Auto-recovering frozen stream (rebuilding WebRTC transport)...");
                    await ExecuteStartStreamAsync();
                }
                catch (Exception ex)
                {
                    AppendLog($"[ERROR] Stream auto-recovery failed: {ex.Message}");
                }
                finally
                {
                    Interlocked.Exchange(ref _streamRecoveryInFlight, 0);
                }
            });
        }

        #endregion

        #endregion

        #region Event Handlers

        /// <summary>
        /// Handles incoming messages from the WebSocket server.
        /// Parses JSON if possible and formats for display.
        /// </summary>
        private void HandleMessageReceived(string message)
        {
            RunOnUIThread(() =>
            {
                // Try to parse and process JSON messages
                try
                {
                    using var doc = JsonDocument.Parse(message);
                    var root = doc.RootElement;
                    string? msgType = null;

                    // Handle specific message types
                    if (root.TryGetProperty("type", out var typeElement))
                    {
                        msgType = typeElement.GetString();

                        // Handle device list response (supports: devices_list, get_devices_response)
                        if ((msgType == "devices_list" || msgType == "get_devices_response" || msgType == "list_devices_response") && 
                            root.TryGetProperty("data", out var dataElement))
                        {
                            var previousId = SelectedDevice?.Id;
                            Devices.Clear();
                            
                            if (dataElement.TryGetProperty("devices", out var devicesElement))
                            {
                                foreach (var device in devicesElement.EnumerateArray())
                                {
                                    var option = ParseDeviceOption(device);
                                    if (option != null)
                                    {
                                        Devices.Add(option);
                                    }
                                }
                            }
                            
                            AppendLog($"[INFO] Received {Devices.Count} device(s)/emulator(s)");

                            DeviceOption? restored = null;
                            if (!string.IsNullOrEmpty(_pendingSelectDeviceId))
                            {
                                foreach (var device in Devices)
                                {
                                    if (device.Id == _pendingSelectDeviceId)
                                    {
                                        restored = device;
                                        break;
                                    }
                                }
                                _pendingSelectDeviceId = null;
                            }
                            else if (!string.IsNullOrEmpty(previousId))
                            {
                                foreach (var device in Devices)
                                {
                                    if (device.Id == previousId)
                                    {
                                        restored = device;
                                        break;
                                    }
                                }
                            }

                            SelectedDevice = restored ?? (Devices.Count > 0 ? Devices[0] : null);
                            (StartStreamCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
                        }

                        // WebSocket connected (server assigns session id immediately)
                        if (msgType == "connected" && ServerMessageJson.TryGetMessageData(root, out var connectedData) &&
                            connectedData.TryGetProperty("session_id", out var connectedSessionElement))
                        {
                            var connectedSessionId = connectedSessionElement.GetString();
                            if (!string.IsNullOrEmpty(connectedSessionId) && string.IsNullOrEmpty(SessionId))
                            {
                                SessionId = connectedSessionId;
                                AppendLog($"[INFO] Server session: {SessionId}");
                            }
                        }

                        // Handle session created response (supports: session_created, create_session_response)
                        if (msgType == "session_created" || msgType == "create_session_response")
                        {
                            if (root.TryGetProperty("success", out var sessionSuccessElement) && !sessionSuccessElement.GetBoolean())
                            {
                                var errorText = root.TryGetProperty("error", out var sessionErrElement)
                                    ? sessionErrElement.GetString()
                                    : "Unknown error";
                                AppendLog($"[ERROR] Session error: {errorText}");
                            }
                            else
                            {
                                string? sessionId = null;
                                string? boundDeviceId = null;
                                string? emulatorName = null;

                                if (ServerMessageJson.TryGetMessageData(root, out var sessionData))
                                {
                                    if (sessionData.TryGetProperty("session_id", out var sessionIdElement))
                                        sessionId = sessionIdElement.GetString();
                                    if (sessionData.TryGetProperty("device_id", out var boundDeviceElement))
                                        boundDeviceId = boundDeviceElement.GetString();
                                    if (sessionData.TryGetProperty("emulator_name", out var emulatorNameElement))
                                        emulatorName = emulatorNameElement.GetString();
                                }
                                else if (root.TryGetProperty("session_id", out var rootSessionElement))
                                {
                                    sessionId = rootSessionElement.GetString();
                                }

                                if (!string.IsNullOrEmpty(sessionId))
                                {
                                    SessionId = sessionId;
                                    HasDeviceSession = true;
                                    BindSessionDevice(boundDeviceId, emulatorName);
                                    AppendLog($"[INFO] Session created: {SessionId}");

                                    MarkDeviceOnline(boundDeviceId, emulatorName);
                                    _pendingSelectDeviceId = boundDeviceId;
                                    _ = ExecuteRefreshDevicesAsync();
                                    (StartStreamCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
                                }
                            }
                        }

                        // Handle session destroyed response
                        if (msgType == "session_destroyed")
                        {
                            string? destroyedDeviceId = null;
                            if (root.TryGetProperty("data", out var destroyedData) &&
                                destroyedData.TryGetProperty("device_id", out var destroyedDeviceElement))
                            {
                                destroyedDeviceId = destroyedDeviceElement.GetString();
                            }

                            HasDeviceSession = false;
                            ClearSessionBinding();
                            AppendLog("[INFO] Session destroyed");

                            if (!string.IsNullOrEmpty(destroyedDeviceId))
                                MarkDeviceOffline(destroyedDeviceId);

                            _ = ExecuteRefreshDevicesAsync();
                        }

                        // Handle session error
                        if (msgType == "session_error" && root.TryGetProperty("error", out var errorElement))
                        {
                            AppendLog($"[ERROR] Session error: {errorElement.GetString()}");
                        }

                        // Handle stream started response - may contain WebRTC offer
                        if (msgType == "stream_started")
                        {
                            _ignoreStreamStoppedResponses = false;

                            if (root.TryGetProperty("success", out var successElement) && !successElement.GetBoolean())
                            {
                                var errorText = root.TryGetProperty("error", out var errElement)
                                    ? errElement.GetString()
                                    : "Unknown error";
                                AppendLog($"[STREAM ERROR] {errorText}");
                                IsStreaming = false;
                                _mirror.WebRtc.SetSignalingRelay(false);
                                StreamStatus = "Error";
                            }
                            else
                            {
                                AppendLog("[STREAM] Stream started from server");
                                IsStreaming = true;
                                StreamStatus = "Negotiating...";
                                ClearStreamBitmap();
                                _mirror.WebRtc.OnStreamStarted();
                                _mirror.WebRtc.SetSignalingRelay(true);

                                if (ServerMessageJson.TryGetMessageData(root, out var streamData))
                                {
                                    if (streamData.TryGetProperty("stream_meta", out var metaEl))
                                    {
                                        var meta = StreamMeta.TryParse(metaEl);
                                        _mirror.ApplyStreamMeta(meta);
                                        if (meta != null)
                                        {
                                            AppendLog(
                                                $"[STREAM] stream_meta stream={meta.StreamWidth}x{meta.StreamHeight} " +
                                                $"device={meta.DeviceLogicalWidth}x{meta.DeviceLogicalHeight} " +
                                                $"provider={meta.Provider}");
                                        }
                                    }

                                    if (ServerMessageJson.TryExtractSdpOffer(streamData, out var sdpOffer))
                                    {
                                        AppendLog("[SIGNALING] WebRTC offer found in stream_started, processing...");
                                        _ = _mirror.WebRtc.HandleOfferAsync(sdpOffer);
                                    }
                                    else
                                    {
                                        AppendLog("[STREAM WARNING] stream_started has no webrtc_offer SDP");
                                    }
                                }
                            }
                        }

                        // Handle stream stopped response
                        if (msgType == "stream_stopped")
                        {
                            if (_ignoreStreamStoppedResponses)
                            {
                                AppendLog("[STREAM] Stream stopped (ignored — new start in progress)");
                                return;
                            }

                            AppendLog("[STREAM] Stream stopped");
                            IsStreaming = false;
                            _mirror.WebRtc.SetSignalingRelay(false);
                            StreamStatus = "No stream";
                            ClearStreamBitmap();
                            CloseStreamWindow();
                        }

                        // Handle WebRTC signaling: offer
                        if (msgType == "webrtc_offer")
                        {
                            AppendLog("[SIGNALING] Received WebRTC offer");
                            string? sdp = null;
                            if (root.TryGetProperty("sdp", out var sdpElement))
                            {
                                sdp = sdpElement.GetString();
                            }
                            else if (ServerMessageJson.TryGetMessageData(root, out var offerData) && ServerMessageJson.TryExtractSdpOffer(offerData, out var offerSdp))
                            {
                                sdp = offerSdp;
                            }

                            if (!string.IsNullOrEmpty(sdp))
                            {
                                _ = _mirror.WebRtc.HandleOfferAsync(sdp);
                            }
                        }

                        // Handle WebRTC signaling: answer
                        if (msgType == "webrtc_answer")
                        {
                            AppendLog("[SIGNALING] Received WebRTC answer");
                            if (root.TryGetProperty("sdp", out var sdpElement))
                            {
                                var sdp = sdpElement.GetString();
                                if (!string.IsNullOrEmpty(sdp))
                                {
                                    _ = _mirror.WebRtc.HandleAnswerAsync(sdp);
                                }
                            }
                        }

                        // Handle WebRTC signaling: ICE candidate (server sends { data: { candidate } })
                        if (msgType == "ice_candidate")
                        {
                            if (ServerMessageJson.TryGetIceCandidateJson(root, out var candidateJson))
                            {
                                _ = _mirror.WebRtc.HandleIceCandidateAsync(candidateJson);
                            }
                            else
                            {
                                AppendLog("[SIGNALING] Received ICE candidate with no payload");
                            }
                        }

                        if (msgType == "ice_candidate_received" &&
                            root.TryGetProperty("success", out var iceOk) &&
                            !iceOk.GetBoolean())
                        {
                            var iceErr = root.TryGetProperty("error", out var iceErrEl)
                                ? iceErrEl.GetString()
                                : "ICE rejected";
                            AppendLog($"[SIGNALING ERROR] {iceErr}");
                        }

                        if (msgType == "scene_cut" && !_isStoppingStream)
                            _mirror.WebRtc.NotifySceneCut();

                        // Screenshot result: save PNG to the local Desktop.
                        if (msgType == "screenshot_taken" &&
                            root.TryGetProperty("success", out var shotOk))
                        {
                            if (shotOk.GetBoolean())
                            {
                                if (ServerMessageJson.TryGetMessageData(root, out var shotData))
                                    TrySaveScreenshotToDesktop(shotData);
                                else
                                    TrySaveScreenshotToDesktop(root);
                            }
                            else
                            {
                                var shotErr = root.TryGetProperty("error", out var shotErrEl)
                                    ? shotErrEl.GetString()
                                    : "Screenshot failed";
                                AppendLog($"[SCREENSHOT] {shotErr}");
                            }
                        }

                        // Capture stall / resume notifications
                        if (msgType == "stream_stall")
                        {
                            _streamWindowViewModel?.NotifyStall();
                        }
                        else if (msgType == "stream_resumed")
                        {
                            _streamWindowViewModel?.NotifyStallCleared();
                        }

                        // Handle stream error (legacy) and typed error responses
                        if (msgType == "stream_error" ||
                            (msgType != null && msgType.EndsWith("_error", StringComparison.Ordinal)))
                        {
                            _ignoreStreamStoppedResponses = false;

                            var errorText = root.TryGetProperty("error", out var streamErrorElement)
                                ? streamErrorElement.GetString()
                                : root.TryGetProperty("message", out var msgEl)
                                    ? msgEl.GetString()
                                    : "Unknown error";

                            IsStreaming = false;
                            _mirror.WebRtc.SetSignalingRelay(false);
                            AppendLog($"[STREAM ERROR] {errorText}");
                            StreamStatus = "Error";
                        }
                    }

                    // Echo the raw payload (capped). Skip types that already have
                    // dedicated handler logs or are high-frequency during streaming.
                    if (!ShouldSkipReceivedEcho(msgType))
                        AppendLog(TruncateForLog(message, "[RECEIVED]"));
                }
                catch (JsonException)
                {
                    // Not valid JSON, display as-is (also capped).
                    AppendLog(TruncateForLog(message, "[RECEIVED]"));
                }
            });
        }

        /// <summary>
        /// Handles connection status changes from the WebSocket service.
        /// </summary>
        private void HandleConnectionStatusChanged(bool isConnected)
        {
            RunOnUIThread(() =>
            {
                IsConnected = isConnected;
                
                // Clear devices and session when disconnected
                if (!isConnected)
                {
                    Devices.Clear();
                    SelectedDevice = null;
                    ResetLocalSessionState();
                }
            });
        }

        /// <summary>
        /// Handles stream status changes from WebRTC client.
        /// </summary>
        private void HandleStreamStatusChanged(StreamStatus status)
        {
            RunOnUIThread(() =>
            {
                StreamStatus = status switch
                {
                    Services.StreamStatus.Idle => "No stream",
                    Services.StreamStatus.Initialized => "Initialized",
                    Services.StreamStatus.Starting => "Negotiating...",
                    Services.StreamStatus.Active => "Streaming",
                    Services.StreamStatus.Stopped => "Stopped",
                    Services.StreamStatus.Error => "Error",
                    _ => "Unknown"
                };

                if (status == Services.StreamStatus.Active)
                    IsStreaming = true;
                else if (status is Services.StreamStatus.Stopped or Services.StreamStatus.Error or Services.StreamStatus.Idle)
                    IsStreaming = false;

                _streamWindowViewModel?.UpdateStatus(StreamStatus);
            });
        }

        /// <summary>
        /// Handles log messages from WebRTC client.
        /// </summary>
        private void HandleWebRTCLog(string log)
        {
            RunOnUIThread(() =>
            {
                AppendLog(log);
            });
        }

        /// <summary>
        /// Handles error messages from WebRTC client.
        /// </summary>
        private void HandleWebRTCError(string error)
        {
            RunOnUIThread(() =>
            {
                AppendLog($"[WEBRTC ERROR] {error}");
            });
        }

        /// <summary>
        /// Handles WebRTC answer created - sends back to server.
        /// </summary>
        private async void HandleAnswerCreated(string sdp)
        {
            if (string.IsNullOrEmpty(SessionId))
                return;

            RunOnUIThread(() =>
            {
                AppendLog($"[WEBRTC] Answer created, sending to server...");
            });

            try
            {
                // Send the answer back to the server
                var answerMessage = new
                {
                    type = "webrtc_answer",
                    emulator_id = SelectedDeviceId ?? "",
                    session_id = SessionId ?? "",
                    answer = new
                    {
                        type = "answer",
                        sdp = sdp
                    }
                };

                string jsonMessage = System.Text.Json.JsonSerializer.Serialize(answerMessage);
                await _webSocketService.SendMessageAsync(jsonMessage);

                RunOnUIThread(() =>
                {
                    AppendLog($"[WEBRTC] Answer sent to server");
                });
            }
            catch (Exception ex)
            {
                RunOnUIThread(() =>
                {
                    AppendLog($"[WEBRTC ERROR] Failed to send answer: {ex.Message}");
                });
            }
        }

        /// <summary>
        /// Handles ICE candidate generated - sends to server.
        /// </summary>
        private async void HandleIceCandidateGenerated(string candidateJson)
        {
            if (string.IsNullOrEmpty(SessionId))
                return;

            RunOnUIThread(() =>
            {
                AppendLog($"[WEBRTC] ICE candidate generated, sending to server...");
            });

            try
            {
                // Parse the candidate JSON and send to server
                var candidateData = System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(candidateJson);
                
                var iceMessage = new
                {
                    type = "ice_candidate",
                    emulator_id = SelectedDeviceId ?? "",
                    session_id = SessionId ?? "",
                    candidate = candidateData
                };

                string jsonMessage = System.Text.Json.JsonSerializer.Serialize(iceMessage);
                await _webSocketService.SendMessageAsync(jsonMessage);

                RunOnUIThread(() =>
                {
                    AppendLog($"[WEBRTC] ICE candidate sent to server");
                });
            }
            catch (Exception ex)
            {
                RunOnUIThread(() =>
                {
                    AppendLog($"[WEBRTC ERROR] Failed to send ICE candidate: {ex.Message}");
                });
            }
        }

        /// <summary>
        /// Handles video frame received from WebRTC - updates the video display.
        /// </summary>
        public Task SendRemoteTapAsync(double normalizedX, double normalizedY) =>
            _remoteControl.SendTapAsync(normalizedX, normalizedY);

        public Task SendRemoteSwipeAsync(double x1, double y1, double x2, double y2, int durationMs = 150) =>
            _remoteControl.SendSwipeAsync(x1, y1, x2, y2, durationMs);

        public Task SendRemoteKeyAsync(string keyCode) =>
            _remoteControl.SendKeyAsync(keyCode);

        public Task SendRemoteTextAsync(string text) =>
            _remoteControl.SendTextAsync(text);

        public Task SendRemoteAppSwitcherAsync() =>
            _remoteControl.SendAppSwitcherAsync();

        /// <summary>
        /// Send a raw adb-shell command for emulator-style buttons that don't
        /// map cleanly to a single keycode. Uses the gateway's existing
        /// shell_command WS protocol — no backend changes required.
        /// </summary>
        public async Task SendShellCommandAsync(string command)
        {
            if (!_webSocketService.IsConnected || string.IsNullOrWhiteSpace(command))
                return;

            var payload = new
            {
                type = "shell_command",
                session_id = SessionId,
                device_id = SelectedDeviceId ?? string.Empty,
                command
            };

            try
            {
                var json = System.Text.Json.JsonSerializer.Serialize(payload);
                await _webSocketService.SendMessageAsync(json);
            }
            catch (Exception ex)
            {
                AppendLog($"[CONTROL] Shell command failed: {ex.Message}");
            }
        }

        /// <summary>
        /// Trigger a device screenshot and pull it to <paramref name="localPath"/>
        /// on whichever host runs the rack-agent (the desktop machine in the
        /// typical single-host dev setup). Uses the gateway's existing
        /// `screenshot` WS message — the server already does `adb pull` to
        /// `local_path` for us.
        /// </summary>
        public async Task SendScreenshotAsync(string localPath)
        {
            if (!_webSocketService.IsConnected)
                return;

            var payload = new
            {
                type = "screenshot",
                session_id = SessionId,
                device_id = SelectedDeviceId ?? string.Empty,
                local_path = localPath
            };

            try
            {
                var json = System.Text.Json.JsonSerializer.Serialize(payload);
                var ok = await _webSocketService.SendMessageAsync(json);
                if (!ok)
                    AppendLog("[SCREENSHOT] Failed to send screenshot request");
                else
                    AppendLog("[SCREENSHOT] Capture requested…");
            }
            catch (Exception ex)
            {
                AppendLog($"[SCREENSHOT] {ex.Message}");
            }
        }

        private void TrySaveScreenshotToDesktop(JsonElement shotData)
        {
            try
            {
                if (!TryGetScreenshotPayload(shotData, out var b64, out var fileName))
                {
                    AppendLog("[SCREENSHOT] No image data in server response");
                    return;
                }

                if (string.IsNullOrWhiteSpace(b64))
                {
                    AppendLog("[SCREENSHOT] Empty image data in server response");
                    return;
                }

                if (string.IsNullOrWhiteSpace(fileName))
                    fileName = $"emustream_{DateTime.Now:yyyyMMdd_HHmmss}.png";

                var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                if (string.IsNullOrWhiteSpace(desktop))
                    desktop = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

                var fullPath = Path.Combine(desktop, fileName);
                Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
                File.WriteAllBytes(fullPath, Convert.FromBase64String(b64));
                AppendLog($"[SCREENSHOT] Saved → {fullPath}");
            }
            catch (Exception ex)
            {
                AppendLog($"[SCREENSHOT] Save failed: {ex.Message}");
            }
        }

        private static bool TryGetScreenshotPayload(JsonElement root, out string? base64, out string? fileName)
        {
            base64 = null;
            fileName = null;

            JsonElement meta = root;
            if (root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object)
                meta = data;

            if (!meta.TryGetProperty("image_base64", out var b64El))
                return false;

            base64 = b64El.GetString();
            if (meta.TryGetProperty("filename", out var fnEl))
                fileName = fnEl.GetString();

            return true;
        }

        /// <summary>
        /// Handles error messages from the WebSocket service.
        /// </summary>
        private void HandleError(string error)
        {
            RunOnUIThread(() =>
            {
                AppendLog($"[ERROR] {error}");
            });
        }

        /// <summary>
        /// Handles general log messages from the WebSocket service.
        /// </summary>
        private void HandleLog(string log)
        {
            RunOnUIThread(() =>
            {
                AppendLog($"[INFO] {log}");
            });
        }

        #endregion

        #region Helpers

        private static DeviceOption? ParseDeviceOption(JsonElement device)
        {
            if (device.ValueKind == JsonValueKind.String)
            {
                var id = device.GetString();
                if (string.IsNullOrEmpty(id))
                    return null;

                return new DeviceOption
                {
                    Id = id,
                    DisplayName = id,
                    Status = "unknown",
                    Kind = "device"
                };
            }

            if (device.ValueKind != JsonValueKind.Object)
                return null;

            if (!device.TryGetProperty("device_id", out var deviceIdElement))
                return null;

            var deviceId = deviceIdElement.GetString();
            if (string.IsNullOrEmpty(deviceId))
                return null;

            var status = device.TryGetProperty("status", out var statusElement)
                ? statusElement.GetString() ?? "unknown"
                : "unknown";
            var kind = device.TryGetProperty("kind", out var kindElement)
                ? kindElement.GetString() ?? "device"
                : "device";
            var name = device.TryGetProperty("name", out var nameElement)
                ? nameElement.GetString() ?? deviceId
                : deviceId;
            var avdName = device.TryGetProperty("avd_name", out var avdElement)
                ? avdElement.GetString()
                : null;
            var platform = device.TryGetProperty("platform", out var platformElement)
                ? platformElement.GetString() ?? "android"
                : "android";
            var targetClass = device.TryGetProperty("target_class", out var targetClassElement)
                ? targetClassElement.GetString() ?? "device"
                : "device";
            string deviceTypeIdentifier = string.Empty;
            if (device.TryGetProperty("metadata", out var metadata) && metadata.ValueKind == JsonValueKind.Object)
            {
                if (metadata.TryGetProperty("deviceTypeIdentifier", out var dtiEl))
                    deviceTypeIdentifier = dtiEl.GetString() ?? string.Empty;
                else if (metadata.TryGetProperty("device_type_identifier", out var dtiSnakeEl))
                    deviceTypeIdentifier = dtiSnakeEl.GetString() ?? string.Empty;
            }

            return new DeviceOption
            {
                Id = deviceId,
                DisplayName = name,
                Status = status,
                Kind = kind,
                AvdName = avdName,
                Platform = platform,
                TargetClass = targetClass,
                DeviceTypeIdentifier = deviceTypeIdentifier
            };
        }

        private void MarkDeviceOnline(string? deviceId, string? avdName = null)
        {
            if (string.IsNullOrEmpty(deviceId) && string.IsNullOrEmpty(avdName))
                return;

            DeviceOption? updatedSelection = null;
            var selectedId = SelectedDevice?.Id;
            var selectedAvd = SelectedDevice?.AvdName ?? selectedId;

            for (var i = Devices.Count - 1; i >= 0; i--)
            {
                var entry = Devices[i];
                var matchesId = !string.IsNullOrEmpty(deviceId) && entry.Id == deviceId;
                var matchesAvd = !string.IsNullOrEmpty(avdName) &&
                                   (entry.Id == avdName || entry.AvdName == avdName);
                var matchesSelection = SelectedDevice != null &&
                                       (entry.Id == selectedId || entry.Id == selectedAvd);

                if (!matchesId && !matchesAvd && !matchesSelection)
                    continue;

                if (entry.Kind == "avd" && entry.Status == "offline" &&
                    !string.IsNullOrEmpty(deviceId) && entry.Id != deviceId)
                {
                    Devices.RemoveAt(i);
                    continue;
                }

                if (entry.IsOnline && entry.Id == (deviceId ?? entry.Id))
                {
                    updatedSelection = entry;
                    continue;
                }

                var online = new DeviceOption
                {
                    Id = deviceId ?? entry.Id,
                    DisplayName = !string.IsNullOrEmpty(avdName) ? avdName : entry.DisplayName,
                    Status = "online",
                    Kind = entry.Kind == "avd" ? "emulator" : entry.Kind,
                    AvdName = avdName ?? entry.AvdName,
                    Platform = entry.Platform,
                    TargetClass = entry.TargetClass
                };
                Devices[i] = online;
                updatedSelection = online;
            }

            if (updatedSelection != null)
            {
                SelectedDevice = updatedSelection;
                return;
            }

            if (string.IsNullOrEmpty(deviceId))
                return;

            var created = new DeviceOption
            {
                Id = deviceId,
                DisplayName = avdName ?? deviceId,
                Status = "online",
                Kind = "emulator",
                AvdName = avdName,
                Platform = SelectedDevice?.Platform ?? "android",
                TargetClass = SelectedDevice?.TargetClass ?? "device"
            };
            Devices.Add(created);
            SelectedDevice = created;
        }

        private void MarkDeviceOffline(string? deviceId)
        {
            if (string.IsNullOrEmpty(deviceId))
                return;

            for (var i = Devices.Count - 1; i >= 0; i--)
            {
                var entry = Devices[i];
                if (entry.Id != deviceId && entry.AvdName != deviceId)
                    continue;

                if (entry.Kind is "emulator" or "simulator" or "device")
                {
                    var wasSelected = SelectedDevice?.Id == deviceId || SelectedDevice?.AvdName == deviceId;
                    Devices.RemoveAt(i);
                    if (wasSelected)
                        SelectedDevice = Devices.Count > 0 ? Devices[0] : null;
                    continue;
                }

                var offline = new DeviceOption
                {
                    Id = entry.Id,
                    DisplayName = entry.DisplayName,
                    Status = "offline",
                    Kind = entry.Kind,
                    AvdName = entry.AvdName,
                    Platform = entry.Platform,
                    TargetClass = entry.TargetClass
                };
                Devices[i] = offline;
                if (SelectedDevice?.Id == deviceId)
                    SelectedDevice = offline;
            }
        }

        private void OpenStreamWindow()
        {
            CloseStreamWindow();
            _streamWindowViewModel = new StreamWindowViewModel(this);
            _streamWindowViewModel.UpdateStatus(StreamStatus);
            _mirror.AttachStreamWindow(_streamWindowViewModel);
            _openStreamWindow?.Invoke(_streamWindowViewModel);
        }

        private void CloseStreamWindow(bool renderAlreadyDetached = false)
        {
            DetachStreamWindowViewModel(detachRender: !renderAlreadyDetached);
            _closeStreamWindow?.Invoke();
        }

        /// <summary>Called when the user closes the mirror window via the window chrome.</summary>
        public void NotifyStreamWindowClosed() => DetachStreamWindowViewModel();

        private void DetachStreamWindowViewModel(bool detachRender = true)
        {
            _streamWindowViewModel?.BeginShutdown();

            if (detachRender)
                _mirror.DetachStreamWindow();

            _streamWindowViewModel?.StopMetricsTimer();

            if (_streamWindowViewModel != null)
                _streamWindowViewModel.OnFrameUpdated = null;
            _streamWindowViewModel = null;
        }

        private void ClearStreamBitmap() => _mirror.Render.ClearBitmap();

        /// <summary>
        /// Append a timestamped message to the logs panel.
        ///
        /// Strict UI-thread budget: this runs on every WS message and every
        /// WebRTC event, so the historical
        /// <c>Logs = Logs + Environment.NewLine + line</c> path (O(N²) in
        /// total log length, with one full re-render of the bound text widget
        /// per call) became the dominant source of mirror stutter during
        /// signaling / scene-cut bursts. The new path:
        ///   • caps the log to <see cref="MaxLogChars"/> with a single
        ///     substring on overflow (rare, bounded cost);
        ///   • mirrors to stdout off the UI thread so a slow terminal cannot
        ///     starve the dispatcher;
        ///   • fires exactly one <see cref="OnPropertyChanged"/> per call.
        /// </summary>
        private void AppendLog(string message)
        {
            var timestamp = DateTime.Now.ToString("HH:mm:ss.fff");
            var logEntry = $"[{timestamp}] {message}";

            try { Console.WriteLine(logEntry); }
            catch { /* stdout unavailable */ }

            string next;
            if (string.IsNullOrEmpty(_logs))
            {
                next = logEntry;
            }
            else
            {
                next = string.Concat(_logs, Environment.NewLine, logEntry);
            }

            if (next.Length > MaxLogChars)
            {
                int trimFrom = next.Length - (MaxLogChars - LogTruncationMarker.Length);
                if (trimFrom < 0) trimFrom = 0;
                next = LogTruncationMarker + next.Substring(trimFrom);
            }

            if (_logs == next)
                return;

            _logs = next;
            ScheduleLogsNotify();
        }

        /// <summary>
        /// Coalesce log panel refreshes so bursts (ICE, scene_cut, control) do not
        /// re-render the full bound text on every single line.
        /// </summary>
        private void ScheduleLogsNotify()
        {
            if (Interlocked.CompareExchange(ref _logsNotifyScheduled, 1, 0) != 0)
                return;

            Dispatcher.UIThread.Post(() =>
            {
                Interlocked.Exchange(ref _logsNotifyScheduled, 0);
                OnPropertyChanged(nameof(Logs));
            }, DispatcherPriority.Background);
        }

        private static bool ShouldSkipReceivedEcho(string? msgType) =>
            msgType is "ice_candidate"
                or "ice_candidate_received"
                or "peer_connected"
                or "webrtc_answer_received";

        private const int MaxReceivedPayloadChars = 800;

        private static string TruncateForLog(string payload, string tag)
        {
            if (string.IsNullOrEmpty(payload)) return tag;
            return payload.Length > MaxReceivedPayloadChars
                ? $"{tag} {payload.Length}B {payload.AsSpan(0, MaxReceivedPayloadChars).ToString()}…"
                : $"{tag} {payload}";
        }

        /// <summary>
        /// Ensures code runs on the UI thread using Avalonia's dispatcher.
        /// </summary>
        private void RunOnUIThread(Action action)
        {
            if (Dispatcher.UIThread.CheckAccess())
            {
                action();
            }
            else
            {
                Dispatcher.UIThread.Post(action);
            }
        }

        #endregion

        #region INotifyPropertyChanged

        public event PropertyChangedEventHandler? PropertyChanged;

        protected virtual void OnPropertyChanged([CallerMemberName] string? propertyName = null)
        {
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
        }

        #endregion

        #region IDisposable

        public void Dispose()
        {
            if (_disposed)
                return;

            _disposed = true;

            // Unsubscribe from events
            _webSocketService.OnMessageReceived -= HandleMessageReceived;
            _webSocketService.OnConnectionStatusChanged -= HandleConnectionStatusChanged;
            _webSocketService.OnError -= HandleError;
            _webSocketService.OnLog -= HandleLog;

            // Unsubscribe from WebRTC events
            _mirror.WebRtc.OnStreamStatusChanged -= HandleStreamStatusChanged;
            _mirror.WebRtc.OnLog -= HandleWebRTCLog;
            _mirror.WebRtc.OnError -= HandleWebRTCError;
            _mirror.WebRtc.OnAnswerCreated -= HandleAnswerCreated;
            _mirror.WebRtc.OnIceCandidateGenerated -= HandleIceCandidateGenerated;
            _mirror.WebRtc.OnDecodedRawFrame = null;

            _webSocketService.Dispose();
            _mirror.Dispose();

            GC.SuppressFinalize(this);
        }

        #endregion
    }
}
