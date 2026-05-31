using Avalonia;
using Avalonia.Threading;
using System.Threading;
using EmulatorDesktopApp.Services;
using EmulatorDesktopApp.Streaming;
using EmulatorDesktopApp.ViewModels.Commands;
using System;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Input;

namespace EmulatorDesktopApp.ViewModels
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
        private string? _selectedDevice;
        private string _sessionId = string.Empty;
        private bool _isRefreshingDevices;
        private string _streamStatus = "No stream";
        private bool _isStreaming;
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
            _mirror.WebRtc.OnSceneCut = () => _mirror.Render.OnSceneCut();

            // Initialize device collection
            Devices = new ObservableCollection<string>();

            // Initialize commands
            ConnectCommand = new AsyncRelayCommand(ExecuteConnectAsync, CanExecuteConnect);
            DisconnectCommand = new AsyncRelayCommand(ExecuteDisconnectAsync, CanExecuteDisconnect);
            RefreshDevicesCommand = new AsyncRelayCommand(ExecuteRefreshDevicesAsync, CanExecuteRefreshDevices);
            CreateSessionCommand = new AsyncRelayCommand(ExecuteCreateSessionAsync, CanExecuteCreateSession);
            DestroySessionCommand = new AsyncRelayCommand(ExecuteDestroySessionAsync, CanExecuteDestroySession);
            StartStreamCommand = new AsyncRelayCommand(ExecuteStartStreamAsync, CanExecuteStartStream);
            StopStreamCommand = new AsyncRelayCommand(ExecuteStopStreamAsync, CanExecuteStopStream);
            ClearLogsCommand = new RelayCommand(ExecuteClearLogs);

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
        /// Collection of available devices from the server.
        /// </summary>
        public ObservableCollection<string> Devices { get; }

        /// <summary>
        /// The currently selected device from the dropdown.
        /// </summary>
        public string? SelectedDevice
        {
            get => _selectedDevice;
            set
            {
                if (_selectedDevice != value)
                {
                    _selectedDevice = value;
                    OnPropertyChanged();
                    (CreateSessionCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
                }
            }
        }

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
        /// Human-readable session status for display (truncated for UI).
        /// </summary>
        public string SessionStatus
        {
            get
            {
                if (string.IsNullOrEmpty(SessionId))
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

        private bool CanExecuteConnect() => !IsConnected && !IsConnecting && !string.IsNullOrWhiteSpace(WebSocketUrl);

        private async Task ExecuteConnectAsync()
        {
            IsConnecting = true;
            try
            {
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

        private bool CanExecuteDisconnect() => IsConnected && !IsConnecting;

        private async Task ExecuteDisconnectAsync()
        {
            IsConnecting = true;
            try
            {
                await _webSocketService.DisconnectAsync();
            }
            finally
            {
                IsConnecting = false;
            }
        }

        private void ExecuteClearLogs()
        {
            Logs = string.Empty;
            AppendLog("Logs cleared");
        }

        private bool CanExecuteRefreshDevices() => IsConnected && !IsRefreshingDevices;

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

        // Block re-creation while a session is already open — the gateway
        // only allows one session per WS connection and the second attempt
        // would either error or silently rebind to the existing session.
        private bool CanExecuteCreateSession() =>
            IsConnected && !string.IsNullOrEmpty(SelectedDevice) && string.IsNullOrEmpty(SessionId);

        private async Task ExecuteCreateSessionAsync()
        {
            if (string.IsNullOrEmpty(SelectedDevice))
            {
                AppendLog("[ERROR] Please select a device first");
                return;
            }

            AppendLog($"Creating session for device: {SelectedDevice}...");
            var message = new
            {
                type = "create_session",
                device = SelectedDevice
            };

            var jsonMessage = JsonSerializer.Serialize(message);
            var success = await _webSocketService.SendMessageAsync(jsonMessage);

            if (!success)
            {
                AppendLog("Failed to send create session command");
            }
        }

        private bool CanExecuteDestroySession() => IsConnected && !string.IsNullOrEmpty(SessionId);

        private async Task ExecuteDestroySessionAsync()
        {
            // Stop stream first if currently streaming
            if (IsStreaming)
            {
                AppendLog("[STREAM] Stopping stream before destroying session...");
                await ExecuteStopStreamAsync();
            }

            AppendLog($"Destroying session: {SessionId}...");
            var message = new
            {
                type = "destroy_session",
                session_id = SessionId
            };

            var jsonMessage = JsonSerializer.Serialize(message);
            var success = await _webSocketService.SendMessageAsync(jsonMessage);

            if (!success)
            {
                AppendLog("Failed to send destroy session command");
            }
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

        private bool CanExecuteStartStream() => IsConnected && !string.IsNullOrEmpty(SessionId) && !IsStreaming;

        private async Task ExecuteStartStreamAsync()
        {
            if (string.IsNullOrEmpty(SessionId))
            {
                AppendLog("[ERROR] Cannot start stream: No active session");
                return;
            }

            AppendLog($"[STREAM] Starting stream for session: {SessionId}...");
            StreamStatus = "Starting...";
            _mirror.WebRtc.SetSignalingRelay(false);
            OpenStreamWindow();

            // Prepare WebRTC client
            await _mirror.WebRtc.PrepareStreamAsync(SessionId);

            // Send start_stream message to server
            var message = WebRTCClient.CreateStartStreamMessage(SessionId, SelectedDevice ?? "");
            var success = await _webSocketService.SendMessageAsync(message);

            if (!success)
            {
                AppendLog("[ERROR] Failed to send start stream command");
                StreamStatus = "Error";
            }
        }

        private bool CanExecuteStopStream() => IsConnected && IsStreaming;

        private async Task ExecuteStopStreamAsync()
        {
            AppendLog($"[STREAM] Stopping stream for session: {SessionId}...");
            StreamStatus = "Stopping...";
            _mirror.WebRtc.SetSignalingRelay(false);

            // Send stop_stream message to server
            var message = WebRTCClient.CreateStopStreamMessage(SessionId);
            var success = await _webSocketService.SendMessageAsync(message);

            if (!success)
            {
                AppendLog("[ERROR] Failed to send stop stream command");
            }

            // Stop WebRTC client
            _mirror.WebRtc.StopStream();
            ClearStreamBitmap();
            CloseStreamWindow();
        }

        /// <summary>
        /// Called from the stream window Stop button.
        /// </summary>
        public Task StopStreamFromStreamWindowAsync() => ExecuteStopStreamAsync();

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

                    // Handle specific message types
                    if (root.TryGetProperty("type", out var typeElement))
                    {
                        var msgType = typeElement.GetString();

                        // Handle device list response (supports: devices_list, get_devices_response)
                        if ((msgType == "devices_list" || msgType == "get_devices_response" || msgType == "list_devices_response") && 
                            root.TryGetProperty("data", out var dataElement))
                        {
                            Devices.Clear();
                            
                            // Format 1: data.devices array
                            if (dataElement.TryGetProperty("devices", out var devicesElement))
                            {
                                foreach (var device in devicesElement.EnumerateArray())
                                {
                                    string? deviceName = null;
                                    if (device.ValueKind == JsonValueKind.Object && 
                                        device.TryGetProperty("device_id", out var deviceIdElement))
                                    {
                                        deviceName = deviceIdElement.GetString();
                                    }
                                    else if (device.ValueKind == JsonValueKind.String)
                                    {
                                        deviceName = device.GetString();
                                    }
                                    
                                    if (!string.IsNullOrEmpty(deviceName))
                                    {
                                        Devices.Add(deviceName);
                                    }
                                }
                            }
                            
                            // Format 2: data.connected_devices array
                            if (dataElement.TryGetProperty("connected_devices", out var connectedDevices))
                            {
                                foreach (var device in connectedDevices.EnumerateArray())
                                {
                                    if (device.TryGetProperty("device_id", out var deviceIdElement))
                                    {
                                        var deviceName = deviceIdElement.GetString();
                                        if (!string.IsNullOrEmpty(deviceName) && !Devices.Contains(deviceName))
                                        {
                                            Devices.Add(deviceName);
                                        }
                                    }
                                }
                            }
                            
                            // Format 3: data.available_emulators.avds array
                            if (dataElement.TryGetProperty("available_emulators", out var emulatorsElement) &&
                                emulatorsElement.TryGetProperty("avds", out var avdsElement))
                            {
                                foreach (var avd in avdsElement.EnumerateArray())
                                {
                                    var avdName = avd.GetString();
                                    if (!string.IsNullOrEmpty(avdName) && !Devices.Contains(avdName))
                                    {
                                        Devices.Add(avdName);
                                    }
                                }
                            }
                            
                            AppendLog($"[INFO] Received {Devices.Count} device(s)/emulator(s)");
                            
                            // Auto-select first device if available
                            if (Devices.Count > 0 && SelectedDevice == null)
                            {
                                SelectedDevice = Devices[0];
                            }
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

                                if (ServerMessageJson.TryGetMessageData(root, out var sessionData) &&
                                    sessionData.TryGetProperty("session_id", out var sessionIdElement))
                                {
                                    sessionId = sessionIdElement.GetString();
                                }
                                else if (root.TryGetProperty("session_id", out var rootSessionElement))
                                {
                                    sessionId = rootSessionElement.GetString();
                                }

                                if (!string.IsNullOrEmpty(sessionId))
                                {
                                    SessionId = sessionId;
                                    AppendLog($"[INFO] Session created: {SessionId}");
                                }
                            }
                        }

                        // Handle session destroyed response
                        if (msgType == "session_destroyed")
                        {
                            SessionId = string.Empty;
                            AppendLog("[INFO] Session destroyed");
                        }

                        // Handle session error
                        if (msgType == "session_error" && root.TryGetProperty("error", out var errorElement))
                        {
                            AppendLog($"[ERROR] Session error: {errorElement.GetString()}");
                        }

                        // Handle stream started response - may contain WebRTC offer
                        if (msgType == "stream_started")
                        {
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

                        if (msgType == "scene_cut")
                            _mirror.WebRtc.NotifySceneCut();

                        // Screenshot result: report the saved path on success.
                        if (msgType == "screenshot_taken" &&
                            root.TryGetProperty("success", out var shotOk) &&
                            shotOk.GetBoolean() &&
                            ServerMessageJson.TryGetMessageData(root, out var shotData))
                        {
                            string? savedPath = null;
                            if (shotData.TryGetProperty("path", out var pathEl))
                                savedPath = pathEl.GetString();
                            else if (shotData.TryGetProperty("local_path", out var localPathEl))
                                savedPath = localPathEl.GetString();

                            if (!string.IsNullOrEmpty(savedPath))
                                AppendLog($"[SCREENSHOT] Saved → {savedPath}");
                        }

                        // Handle stream error (legacy) and typed error responses
                        if (msgType == "stream_error" ||
                            (msgType != null && msgType.EndsWith("_error", StringComparison.Ordinal)))
                        {
                            var errorText = root.TryGetProperty("error", out var streamErrorElement)
                                ? streamErrorElement.GetString()
                                : "Unknown error";
                            AppendLog($"[STREAM ERROR] {errorText}");
                            IsStreaming = false;
                            StreamStatus = "Error";
                        }
                    }

                    // Echo the raw payload (capped). The previous path
                    // pretty-printed every message with a freshly-allocated
                    // `JsonSerializerOptions { WriteIndented = true }`, which
                    // both bypassed System.Text.Json's per-options metadata
                    // cache and produced 5–20 KB of UI-thread string churn
                    // per message during ICE / scene-cut bursts — measurable
                    // mirror stutter.
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
                    SessionId = string.Empty;
                    
                    // Stop stream if active
                    if (IsStreaming)
                    {
                        _mirror.WebRtc.StopStream();
                        IsStreaming = false;
                        StreamStatus = "No stream";
                        ClearStreamBitmap();
                        CloseStreamWindow();
                    }
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
                    emulator_id = SelectedDevice ?? "",
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
                    emulator_id = SelectedDevice ?? "",
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
                device_id = SelectedDevice ?? string.Empty,
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
            if (!_webSocketService.IsConnected || string.IsNullOrWhiteSpace(localPath))
                return;

            var payload = new
            {
                type = "screenshot",
                session_id = SessionId,
                device_id = SelectedDevice ?? string.Empty,
                local_path = localPath
            };

            try
            {
                var json = System.Text.Json.JsonSerializer.Serialize(payload);
                var ok = await _webSocketService.SendMessageAsync(json);
                if (!ok)
                    AppendLog("[SCREENSHOT] Failed to send screenshot request");
                else
                    AppendLog($"[SCREENSHOT] Requested → {localPath}");
            }
            catch (Exception ex)
            {
                AppendLog($"[SCREENSHOT] {ex.Message}");
            }
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

        private void OpenStreamWindow()
        {
            CloseStreamWindow();
            _streamWindowViewModel = new StreamWindowViewModel(this);
            _streamWindowViewModel.UpdateStatus(StreamStatus);
            _mirror.AttachStreamWindow(_streamWindowViewModel);
            _openStreamWindow?.Invoke(_streamWindowViewModel);
        }

        private void CloseStreamWindow()
        {
            _mirror.DetachStreamWindow();
            _streamWindowViewModel?.StopMetricsTimer();
            _closeStreamWindow?.Invoke();
            _streamWindowViewModel = null;
            ClearStreamBitmap();
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

            // Stdout mirror is best-effort and never on the UI thread.
            try { Task.Run(() => { try { Console.WriteLine(logEntry); } catch { } }); }
            catch { /* thread-pool unavailable: drop the mirror, keep the panel */ }

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

            Logs = next;
        }

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
