using System.Text.Json;

namespace EmulatorDesktopApp.Services
{
    /// <summary>
    /// Shared JSON helpers for WebSocket server message envelopes.
    /// </summary>
    public static class ServerMessageJson
    {
        /// <summary>
        /// Reads the server envelope "data" object when present.
        /// </summary>
        public static bool TryGetMessageData(JsonElement root, out JsonElement data)
        {
            if (root.TryGetProperty("data", out data) && data.ValueKind == JsonValueKind.Object)
                return true;

            data = default;
            return false;
        }

        /// <summary>
        /// Extracts SDP from webrtc_offer object or raw sdp field.
        /// </summary>
        public static bool TryExtractSdpOffer(JsonElement data, out string sdpOffer)
        {
            sdpOffer = string.Empty;

            if (data.TryGetProperty("webrtc_offer", out var offerElement))
            {
                if (offerElement.ValueKind == JsonValueKind.String)
                {
                    sdpOffer = offerElement.GetString() ?? string.Empty;
                }
                else if (offerElement.ValueKind == JsonValueKind.Object &&
                         offerElement.TryGetProperty("sdp", out var sdpElem))
                {
                    sdpOffer = sdpElem.GetString() ?? string.Empty;
                }
            }
            else if (data.TryGetProperty("sdp", out var directSdpElem))
            {
                sdpOffer = directSdpElem.GetString() ?? string.Empty;
            }

            return !string.IsNullOrEmpty(sdpOffer);
        }

        /// <summary>
        /// Resolves ICE candidate JSON from server messages (data.candidate or root candidate).
        /// </summary>
        public static bool TryGetIceCandidateJson(JsonElement root, out string candidateJson)
        {
            candidateJson = string.Empty;

            if (TryGetMessageData(root, out var data) && data.TryGetProperty("candidate", out var dataCandidate))
            {
                candidateJson = dataCandidate.GetRawText();
                return true;
            }

            if (root.TryGetProperty("candidate", out var rootCandidate))
            {
                candidateJson = rootCandidate.GetRawText();
                return true;
            }

            return false;
        }
    }
}
