using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using EmulatorDesktopApp.ViewModels;

namespace EmulatorDesktopApp;

public partial class StreamWindow : Window
{
  public StreamWindow()
  {
    InitializeComponent();
    AddHandler(PointerPressedEvent, OnPointerPressed, handledEventsToo: true);
    AddHandler(PointerReleasedEvent, OnPointerReleased, handledEventsToo: true);
    KeyDown += OnKeyDown;
  }

  private async void OnKeyDown(object? sender, KeyEventArgs e)
  {
    if (DataContext is not StreamWindowViewModel vm)
      return;

    string? keyCode = e.Key switch
    {
      Key.Back => "KEYCODE_BACK",
      Key.Home => "KEYCODE_HOME",
      Key.Escape => "KEYCODE_BACK",
      Key.Enter => "KEYCODE_ENTER",
      _ => null
    };

    if (keyCode != null)
    {
      await vm.SendRemoteKeyAsync(keyCode);
      e.Handled = true;
    }
  }

  /// <summary>
  /// Forces the video surface to repaint after in-place bitmap updates.
  /// </summary>
  public void InvalidateVideoFrame()
  {
    VideoImage?.InvalidateVisual();
  }

  private async void OnPointerPressed(object? sender, PointerPressedEventArgs e)
  {
    if (DataContext is not StreamWindowViewModel vm)
      return;

    if (VideoSurface == null)
      return;

    var pos = e.GetPosition(VideoSurface);
    var size = VideoSurface.Bounds.Size;
    if (size.Width <= 0 || size.Height <= 0)
      return;

    await vm.HandlePointerPressedAsync(pos, size);
    e.Handled = true;
  }

  private async void OnPointerReleased(object? sender, PointerReleasedEventArgs e)
  {
    if (DataContext is not StreamWindowViewModel vm)
      return;

    if (VideoSurface == null)
      return;

    var pos = e.GetPosition(VideoSurface);
    var size = VideoSurface.Bounds.Size;
    if (size.Width <= 0 || size.Height <= 0)
      return;

    await vm.HandlePointerReleasedAsync(pos, size);
    e.Handled = true;
  }
}
