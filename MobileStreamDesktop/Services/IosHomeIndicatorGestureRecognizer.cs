using System;
using Avalonia;

namespace MobileStreamDesktop.Services;

/// <summary>
/// Recognizes iOS home-indicator gestures in normalized device space [0,1].
/// SpringBoard edge swipes cannot be injected as HID swipes; the viewer maps
/// recognized gestures to Home / App Switcher hardware-button actions.
/// </summary>
public sealed class IosHomeIndicatorGestureRecognizer
{
    public enum GestureAction
    {
        None,
        Home,
        AppSwitcher
    }

    // Bottom band where the home indicator lives (matches iOS safe-area edge).
    public const double HomeZoneMinY = 0.92;

    // Minimum upward travel (normalized) to count as a deliberate swipe.
    public const double MinUpwardTravelHome = 0.10;
    public const double MinUpwardTravelHold = 0.06;

    // Hold long enough with some upward drag → App Switcher (matches Simulator).
    public const int HoldDurationMs = 420;

    // Quick flick shorter than this with enough travel → Home.
    public const int QuickFlickMaxMs = 280;

    // normalized-units / ms — separates a flick from a slow drag.
    public const double MinHomeVelocity = 0.00042;

    // Upward motion must dominate horizontal drift.
    public const double VerticalDominanceRatio = 1.6;

    private bool _active;
    private bool _consumed;
    private Point _start;
    private DateTime _startUtc;
    private double _maxUpwardTravel;
    private double _maxHorizontalTravel;

    public bool IsActive => _active;
    public bool IsConsumed => _consumed;

    public void Reset()
    {
        _active = false;
        _consumed = false;
        _maxUpwardTravel = 0;
        _maxHorizontalTravel = 0;
    }

    public void Begin(double nx, double ny)
    {
        Reset();
        if (!IsInHomeZone(ny))
            return;

        _active = true;
        _start = new Point(nx, ny);
        _startUtc = DateTime.UtcNow;
    }

    /// <summary>
    /// Call on every move while the pointer is down. Returns AppSwitcher when the
    /// hold threshold is met mid-gesture (swipe up and hold).
    /// </summary>
    public GestureAction Update(double nx, double ny)
    {
        if (!_active || _consumed)
            return GestureAction.None;

        TrackTravel(nx, ny);

        if (ShouldOpenAppSwitcher(ElapsedMs, onRelease: false))
        {
            _consumed = true;
            return GestureAction.AppSwitcher;
        }

        return GestureAction.None;
    }

    /// <summary>
    /// Call on pointer up. Returns None if this was not a home-indicator gesture.
    /// </summary>
    public GestureAction Complete(double nx, double ny, int elapsedMs)
    {
        if (!_active)
            return GestureAction.None;

        if (_consumed)
            return GestureAction.None;

        TrackTravel(nx, ny);

        if (!IsMostlyUpward())
            return GestureAction.None;

        if (ShouldOpenAppSwitcher(elapsedMs, onRelease: true))
        {
            _consumed = true;
            return GestureAction.AppSwitcher;
        }

        if (ShouldGoHome(elapsedMs))
        {
            _consumed = true;
            return GestureAction.Home;
        }

        return GestureAction.None;
    }

    public static bool IsInHomeZone(double normalizedY) =>
        normalizedY >= HomeZoneMinY;

    private void TrackTravel(double nx, double ny)
    {
        double upward = _start.Y - ny;
        double horizontal = Math.Abs(nx - _start.X);

        if (upward > _maxUpwardTravel)
            _maxUpwardTravel = upward;
        if (horizontal > _maxHorizontalTravel)
            _maxHorizontalTravel = horizontal;
    }

    private bool IsMostlyUpward()
    {
        if (_maxUpwardTravel < MinUpwardTravelHold)
            return false;
        if (_maxHorizontalTravel <= 0)
            return true;
        return _maxUpwardTravel >= _maxHorizontalTravel * VerticalDominanceRatio;
    }

    private bool ShouldOpenAppSwitcher(int elapsedMs, bool onRelease)
    {
        if (!IsMostlyUpward())
            return false;

        if (_maxUpwardTravel < MinUpwardTravelHold)
            return false;

        // Mid-gesture hold: finger still down after moving up from the indicator.
        if (!onRelease && elapsedMs >= HoldDurationMs)
            return true;

        // Slow swipe-up on release (did not qualify as a quick home flick).
        if (onRelease && elapsedMs >= HoldDurationMs && _maxUpwardTravel >= MinUpwardTravelHome)
            return true;

        // Deliberate slow drag that never hit the mid-gesture hold timer.
        if (onRelease
            && elapsedMs > QuickFlickMaxMs
            && _maxUpwardTravel >= MinUpwardTravelHome)
            return true;

        return false;
    }

    private bool ShouldGoHome(int elapsedMs)
    {
        if (_maxUpwardTravel < MinUpwardTravelHome)
            return false;

        double velocity = _maxUpwardTravel / Math.Max(elapsedMs, 1);
        return elapsedMs <= QuickFlickMaxMs || velocity >= MinHomeVelocity;
    }

    private int ElapsedMs =>
        (int)Math.Max(0, (DateTime.UtcNow - _startUtc).TotalMilliseconds);
}
