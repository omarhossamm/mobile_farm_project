# Android Emulator Control Panel

A cross-platform desktop application built with Avalonia UI and .NET for controlling Android emulators via WebSocket connection.

## Features

- **WebSocket Connection**: Connect to a Node.js WebSocket server for real-time communication
- **Device Management**: View and select available Android devices/emulators
- **Session Control**: Create and destroy emulator sessions
- **Emulator Control**: Start emulators by name
- **Stream Control**: Start/stop WebRTC streaming (prepared for future video rendering)
- **Real-time Logs**: Monitor all WebSocket communication with auto-scrolling log viewer
- **Modern Dark UI**: Professional developer tool appearance with dark theme

## Prerequisites

- [.NET 10.0 SDK](https://dotnet.microsoft.com/download) or later
- A running WebSocket server (default: `ws://localhost:3000`)

## Quick Start

```bash
# Navigate to project directory
cd EmulatorDesktopApp

# Build the project
dotnet build

# Run the application
dotnet run
```

## Project Structure

```
EmulatorDesktopApp/
├── App.axaml              # Application configuration (dark theme)
├── App.axaml.cs           # Application entry point
├── MainWindow.axaml       # Main window UI layout
├── MainWindow.axaml.cs    # Main window code-behind (auto-scroll)
├── Program.cs             # .NET entry point
├── Services/
│   ├── WebSocketService.cs    # WebSocket connection management
│   └── WebRTCClient.cs        # WebRTC signaling placeholder (streaming prep)
└── ViewModels/
    └── MainWindowViewModel.cs # MVVM ViewModel with commands
```

## Architecture

The application follows the **MVVM (Model-View-ViewModel)** pattern:

- **View** (`MainWindow.axaml`): UI layout and styling
- **ViewModel** (`MainWindowViewModel.cs`): Business logic, commands, and data binding
- **Service** (`WebSocketService.cs`): WebSocket communication layer

### Key Components

#### WebSocketService
Handles all WebSocket operations:
- `ConnectAsync(url)` - Establish connection
- `SendMessageAsync(message)` - Send JSON messages
- `DisconnectAsync()` - Graceful disconnection
- Event callbacks for messages, errors, and connection status

#### MainWindowViewModel
Manages UI state and commands:
- `ConnectCommand` / `DisconnectCommand`
- `RefreshDevicesCommand`
- `CreateSessionCommand` / `DestroySessionCommand`
- `StartEmulatorCommand`
- `StartStreamCommand` / `StopStreamCommand`
- `ClearLogsCommand`

## WebSocket Protocol

### Messages Sent

**Get Devices**
```json
{"type": "get_devices"}
```

**Create Session**
```json
{"type": "create_session", "device": "emulator-5554"}
```

**Destroy Session**
```json
{"type": "destroy_session", "session_id": "uuid-here"}
```

**Start Emulator**
```json
{"type": "start_emulator", "emulator_name": "Pixel_5_API_30"}
```

**Start Stream** (requires active session)
```json
{"type": "start_stream", "session_id": "uuid-here", "device_id": "emulator-5554"}
```

**Stop Stream**
```json
{"type": "stop_stream", "session_id": "uuid-here"}
```

### Expected Responses

**Device List**
```json
{
  "type": "devices_list",
  "success": true,
  "data": {
    "devices": [
      {"device_id": "emulator-5554", "status": "online"}
    ]
  }
}
```

**Session Created**
```json
{
  "type": "session_created",
  "data": {
    "session_id": "uuid-here"
  }
}
```

**Session Destroyed**
```json
{"type": "session_destroyed"}
```

**Stream Started**
```json
{"type": "stream_started"}
```

**Stream Stopped**
```json
{"type": "stream_stopped"}
```

**WebRTC Signaling** (future implementation)
```json
{"type": "webrtc_offer", "sdp": "..."}
{"type": "webrtc_answer", "sdp": "..."}
{"type": "ice_candidate", "candidate": {...}}
```

## UI Overview

| Section | Description |
|---------|-------------|
| **Connection Panel** | WebSocket URL input, Connect/Disconnect buttons, status indicator |
| **Logs Panel** | Real-time message log with Clear button |
| **Device Selection** | Device dropdown, session status, Refresh/Create/Destroy buttons |
| **Emulator Control** | Emulator name input, Start Emulator button |
| **Stream Control** | Video placeholder, stream status, Start/Stop Stream buttons |

## Dependencies

- **Avalonia** (12.0.3) - Cross-platform UI framework
- **Avalonia.Desktop** - Desktop platform support
- **Avalonia.Themes.Fluent** - Modern Fluent design theme
- **Avalonia.Fonts.Inter** - Inter font family

## License

MIT License
