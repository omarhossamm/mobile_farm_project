using System;
using System.Globalization;
using System.Text.Json;
using System.Threading.Tasks;

namespace EmulatorDesktopApp.Services
{
    /// <summary>
    /// Sends remote control events to the gateway over WebSocket (separate from WebRTC video).
    /// </summary>
    public class RemoteControlService
    {
        private readonly WebSocketService _webSocket;

        public RemoteControlService(WebSocketService webSocket)
        {
            _webSocket = webSocket ?? throw new ArgumentNullException(nameof(webSocket));
        }

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

        private async Task SendControlAsync(object controlEvent)
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
