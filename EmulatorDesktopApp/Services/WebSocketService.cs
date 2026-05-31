using System;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace EmulatorDesktopApp.Services
{
    /// <summary>
    /// WebSocket service responsible for managing persistent connections to the emulator server.
    /// Handles connection lifecycle, message sending/receiving, and automatic reconnection.
    /// </summary>
    public class WebSocketService : IDisposable
    {
        // The underlying WebSocket client instance
        private ClientWebSocket? _webSocket;
        
        // Cancellation token source for graceful shutdown of receive loop
        private CancellationTokenSource? _receiveCts;
        
        // Buffer size for receiving messages (16KB should handle most messages)
        private const int BufferSize = 16384;
        
        // Flag to track disposal state
        private bool _disposed;

        #region Events

        /// <summary>
        /// Fired when a message is received from the WebSocket server.
        /// </summary>
        public event Action<string>? OnMessageReceived;

        /// <summary>
        /// Fired when the connection status changes (connected/disconnected).
        /// </summary>
        public event Action<bool>? OnConnectionStatusChanged;

        /// <summary>
        /// Fired when an error occurs during WebSocket operations.
        /// </summary>
        public event Action<string>? OnError;

        /// <summary>
        /// Fired for general log messages (info, debug, etc).
        /// </summary>
        public event Action<string>? OnLog;

        #endregion

        #region Properties

        /// <summary>
        /// Returns true if the WebSocket is currently connected and open.
        /// </summary>
        public bool IsConnected => _webSocket?.State == WebSocketState.Open;

        #endregion

        #region Connection Management

        /// <summary>
        /// Establishes a connection to the WebSocket server.
        /// </summary>
        /// <param name="url">The WebSocket URL to connect to (e.g., ws://localhost:3000)</param>
        /// <param name="cancellationToken">Optional cancellation token</param>
        /// <returns>True if connection was successful, false otherwise</returns>
        public async Task<bool> ConnectAsync(string url, CancellationToken cancellationToken = default)
        {
            try
            {
                // Clean up any existing connection first
                await DisconnectAsync();

                // Validate URL format
                if (string.IsNullOrWhiteSpace(url))
                {
                    OnError?.Invoke("WebSocket URL cannot be empty");
                    return false;
                }

                if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
                {
                    OnError?.Invoke($"Invalid WebSocket URL format: {url}");
                    return false;
                }

                if (uri.Scheme != "ws" && uri.Scheme != "wss")
                {
                    OnError?.Invoke($"URL must use ws:// or wss:// scheme. Got: {uri.Scheme}");
                    return false;
                }

                OnLog?.Invoke($"Connecting to {url}...");

                // Create new WebSocket instance
                _webSocket = new ClientWebSocket();
                
                // Configure WebSocket options (keep-alive, timeouts, etc.)
                _webSocket.Options.KeepAliveInterval = TimeSpan.FromSeconds(30);

                // Attempt connection with timeout
                using var connectCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                connectCts.CancelAfter(TimeSpan.FromSeconds(10)); // 10 second connection timeout

                await _webSocket.ConnectAsync(uri, connectCts.Token);

                if (_webSocket.State == WebSocketState.Open)
                {
                    OnLog?.Invoke($"Successfully connected to {url}");
                    OnConnectionStatusChanged?.Invoke(true);

                    // Start the receive loop in the background
                    _receiveCts = new CancellationTokenSource();
                    _ = ReceiveLoopAsync(_receiveCts.Token);

                    return true;
                }
                else
                {
                    OnError?.Invoke($"Connection failed. WebSocket state: {_webSocket.State}");
                    return false;
                }
            }
            catch (OperationCanceledException)
            {
                OnError?.Invoke("Connection attempt timed out");
                return false;
            }
            catch (WebSocketException ex)
            {
                OnError?.Invoke($"WebSocket error: {ex.Message}");
                return false;
            }
            catch (Exception ex)
            {
                OnError?.Invoke($"Unexpected error during connection: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Gracefully disconnects from the WebSocket server.
        /// </summary>
        public async Task DisconnectAsync()
        {
            try
            {
                // Cancel the receive loop first
                _receiveCts?.Cancel();
                _receiveCts?.Dispose();
                _receiveCts = null;

                if (_webSocket != null)
                {
                    // Only attempt close if WebSocket is in a closeable state
                    if (_webSocket.State == WebSocketState.Open || 
                        _webSocket.State == WebSocketState.CloseReceived)
                    {
                        OnLog?.Invoke("Closing WebSocket connection...");
                        
                        using var closeCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                        await _webSocket.CloseAsync(
                            WebSocketCloseStatus.NormalClosure,
                            "Client disconnecting",
                            closeCts.Token);
                    }

                    _webSocket.Dispose();
                    _webSocket = null;

                    OnLog?.Invoke("Disconnected from server");
                    OnConnectionStatusChanged?.Invoke(false);
                }
            }
            catch (Exception ex)
            {
                OnLog?.Invoke($"Error during disconnect: {ex.Message}");
                _webSocket?.Dispose();
                _webSocket = null;
                OnConnectionStatusChanged?.Invoke(false);
            }
        }

        #endregion

        #region Message Handling

        /// <summary>
        /// Sends a text message to the WebSocket server.
        /// </summary>
        /// <param name="message">The message to send</param>
        /// <returns>True if message was sent successfully, false otherwise</returns>
        public async Task<bool> SendMessageAsync(string message)
        {
            if (_webSocket?.State != WebSocketState.Open)
            {
                OnError?.Invoke("Cannot send message: WebSocket is not connected");
                return false;
            }

            try
            {
                var bytes = Encoding.UTF8.GetBytes(message);
                var segment = new ArraySegment<byte>(bytes);

                await _webSocket.SendAsync(segment, WebSocketMessageType.Text, true, CancellationToken.None);
                
                OnLog?.Invoke($"Sent: {TruncateMessage(message, 200)}");
                return true;
            }
            catch (WebSocketException ex)
            {
                OnError?.Invoke($"Failed to send message: {ex.Message}");
                await HandleConnectionLost();
                return false;
            }
            catch (Exception ex)
            {
                OnError?.Invoke($"Unexpected error sending message: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Continuously receives messages from the WebSocket server.
        /// This method runs until the connection is closed or cancelled.
        /// </summary>
        private async Task ReceiveLoopAsync(CancellationToken cancellationToken)
        {
            var buffer = new byte[BufferSize];
            var messageBuilder = new StringBuilder();

            try
            {
                while (!cancellationToken.IsCancellationRequested && 
                       _webSocket?.State == WebSocketState.Open)
                {
                    messageBuilder.Clear();
                    WebSocketReceiveResult result;

                    // Read message fragments until we get the complete message
                    do
                    {
                        var segment = new ArraySegment<byte>(buffer);
                        result = await _webSocket.ReceiveAsync(segment, cancellationToken);

                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            OnLog?.Invoke($"Server initiated close: {result.CloseStatusDescription}");
                            await HandleConnectionLost();
                            return;
                        }

                        if (result.MessageType == WebSocketMessageType.Text)
                        {
                            var text = Encoding.UTF8.GetString(buffer, 0, result.Count);
                            messageBuilder.Append(text);
                        }
                        else if (result.MessageType == WebSocketMessageType.Binary)
                        {
                            OnLog?.Invoke("Received binary message (ignored - text expected)");
                        }
                    } 
                    while (!result.EndOfMessage);

                    // Process the complete message
                    if (messageBuilder.Length > 0)
                    {
                        var message = messageBuilder.ToString();
                        OnMessageReceived?.Invoke(message);
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Normal cancellation, do nothing
                OnLog?.Invoke("Receive loop cancelled");
            }
            catch (WebSocketException ex)
            {
                if (!cancellationToken.IsCancellationRequested)
                {
                    OnError?.Invoke($"WebSocket receive error: {ex.Message}");
                    await HandleConnectionLost();
                }
            }
            catch (Exception ex)
            {
                if (!cancellationToken.IsCancellationRequested)
                {
                    OnError?.Invoke($"Unexpected error in receive loop: {ex.Message}");
                    await HandleConnectionLost();
                }
            }
        }

        /// <summary>
        /// Handles unexpected connection loss by cleaning up resources and notifying listeners.
        /// </summary>
        private async Task HandleConnectionLost()
        {
            OnLog?.Invoke("Connection lost");
            OnConnectionStatusChanged?.Invoke(false);
            
            try
            {
                _webSocket?.Dispose();
                _webSocket = null;
            }
            catch
            {
                // Ignore disposal errors
            }

            await Task.CompletedTask;
        }

        #endregion

        #region Helpers

        /// <summary>
        /// Truncates a message to a maximum length for logging purposes.
        /// </summary>
        private static string TruncateMessage(string message, int maxLength)
        {
            if (message.Length <= maxLength)
                return message;
            
            return message.Substring(0, maxLength) + "...";
        }

        #endregion

        #region IDisposable

        public void Dispose()
        {
            if (_disposed)
                return;

            _disposed = true;

            _receiveCts?.Cancel();
            _receiveCts?.Dispose();
            _webSocket?.Dispose();

            GC.SuppressFinalize(this);
        }

        #endregion
    }
}
