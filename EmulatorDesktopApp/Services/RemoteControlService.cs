using System;
using System.Globalization;
using System.Text.Json;
using System.Threading.Tasks;

namespace EmulatorDesktopApp.Services
{
    /// <summary>
    /// Sends remote control events via WebRTC DataChannel (primary) or WebSocket fallback.
    /// </summary>
    public class RemoteControlService
    {
        private readonly WebSocketService _webSocket;
        private WebRTCClient? _webrtc;

        public RemoteControlService(WebSocketService webSocket)
        {
            _webSocket = webSocket ?? throw new ArgumentNullException(nameof(webSocket));
        }

        public void AttachWebRtc(WebRTCClient webRtc) => _webrtc = webRtc;

        public Task SendTapAsync(double normalizedX, double normalizedY)
        {
            return SendControlAsync(new
            {
                action = "tap",
                x = Clamp01(normalizedX),
                y = Clamp01(normalizedY)
            });
        }

        public Task SendSwipeAsync(double x1, double y1, double x2, double y2, int durationMs = 150)
        {
            return SendControlAsync(new
            {
                action = "swipe",
                x1 = Clamp01(x1),
                y1 = Clamp01(y1),
                x2 = Clamp01(x2),
                y2 = Clamp01(y2),
                durationMs
            });
        }

        public Task SendKeyAsync(string keyCode)
        {
            return SendControlAsync(new { action = "key", keyCode });
        }

        public Task SendTextAsync(string text)
        {
            if (string.IsNullOrEmpty(text))
                return Task.CompletedTask;

            return SendControlAsync(new { action = "text", text });
        }

        /// <summary>
        /// iOS App Switcher. Home-indicator edge swipes are SpringBoard system
        /// gestures; the gateway maps this to a double Home-button press.
        /// </summary>
        public Task SendAppSwitcherAsync() =>
            SendControlAsync(new { action = "appSwitcher" });

        private Task SendControlAsync(object controlEvent)
        {
            // Mark input intent so the freeze watchdog can correlate user actions
            // with subsequent video updates (recover only when input yields no frame).
            _webrtc?.NotifyInputSent();

            if (_webrtc?.TrySendControlViaDataChannel(controlEvent) == true)
                return Task.CompletedTask;

            return SendControlViaWebSocketAsync(controlEvent);
        }

        private async Task SendControlViaWebSocketAsync(object controlEvent)
        {
            if (!_webSocket.IsConnected)
                return;

            var message = JsonSerializer.Serialize(new
            {
                type = "control",
                @event = controlEvent
            });

            await _webSocket.SendMessageAsync(message);
        }

        private static double Clamp01(double v) =>
            Math.Max(0, Math.Min(1, v));
    }
}
