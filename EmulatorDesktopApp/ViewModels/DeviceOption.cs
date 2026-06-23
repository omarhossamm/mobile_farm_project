namespace EmulatorDesktopApp.ViewModels;

using System;
using Avalonia.Media;

/// <summary>
/// One entry in the device picker (Android emulators / iOS simulators).
/// </summary>
public sealed class DeviceOption
{
    public required string Id { get; init; }

    public required string DisplayName { get; init; }

    public required string Status { get; init; }

    public string Kind { get; init; } = "device";

    public string? AvdName { get; init; }

    public string Platform { get; init; } = "android";

    public string TargetClass { get; init; } = "device";

    public string DeviceTypeIdentifier { get; init; } = string.Empty;

    public bool IsOnline => string.Equals(Status, "online", StringComparison.OrdinalIgnoreCase);

    public string PlatformLabel
    {
        get
        {
            if (IsIos)
                return "iOS";
            if (string.Equals(Kind, "avd", StringComparison.OrdinalIgnoreCase))
                return "AVD";
            return "Android";
        }
    }

    public Color PlatformColor => IsIos
        ? Color.Parse("#007AFF")
        : Color.Parse("#3DDC84");

    private bool IsIos =>
        string.Equals(Platform, "ios", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(Kind, "simulator", StringComparison.OrdinalIgnoreCase);

    public Color StatusColor => IsOnline
        ? Color.Parse("#4CAF50")
        : Color.Parse("#F44336");

    public override string ToString() => DisplayName;
}
