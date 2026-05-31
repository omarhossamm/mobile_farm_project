namespace EmulatorDesktopApp.ViewModels;

using System;
using Avalonia.Media;

/// <summary>
/// One entry in the device picker (online ADB device, offline ADB entry, or stopped AVD).
/// </summary>
public sealed class DeviceOption
{
    public required string Id { get; init; }

    public required string DisplayName { get; init; }

    public required string Status { get; init; }

    public string Kind { get; init; } = "device";

    public string? AvdName { get; init; }

    public bool IsOnline => string.Equals(Status, "online", StringComparison.OrdinalIgnoreCase);

    public Color StatusColor => IsOnline
        ? Color.Parse("#4CAF50")
        : Color.Parse("#F44336");

    public override string ToString() => DisplayName;
}