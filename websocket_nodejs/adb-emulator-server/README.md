# Android Emulator Control Server

A production-ready Node.js WebSocket server for controlling Android emulators via ADB.

## Features

- **WebSocket Communication**: Real-time bidirectional communication with clients
- **Session Management**: Each client gets a unique session with device mapping
- **Emulator Control**: Start/stop Android emulators programmatically
- **ADB Commands**: Execute any ADB command on connected devices
- **Multi-device Support**: Manage multiple emulators and devices simultaneously
- **Error Handling**: Comprehensive error handling and logging
- **Health Checks**: HTTP endpoints for monitoring

## Prerequisites

- Node.js 16+ 
- Android SDK with ADB installed and in PATH
- Android emulator (for emulator features)

## Installation

```bash
cd adb-emulator-server
npm install
```

## Running the Server

```bash
# Start the server
node server.js

# Or use npm script
npm start

# Development mode with auto-reload (Node.js 18+)
npm run dev
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | WebSocket server port |
| `HOST` | `0.0.0.0` | Server bind address |
| `DEBUG` | `false` | Enable debug logging |
| `ADB_PATH` | `adb` | Path to ADB executable |
| `EMULATOR_PATH` | `emulator` | Path to emulator executable |
| `ADB_TIMEOUT` | `30000` | ADB command timeout (ms) |
| `EMULATOR_START_TIMEOUT` | `120000` | Emulator start timeout (ms) |
| `HEARTBEAT_INTERVAL` | `30000` | WebSocket heartbeat interval (ms) |
| `SESSION_CLEANUP_INTERVAL` | `300000` | Stale session cleanup interval (ms) |
| `KILL_EMULATOR_ON_DISCONNECT` | `true` | Kill emulators when session disconnects |

## Isolated Session Workspaces

The server supports multiple developers running `flutter run` against
the **same** origin project at the **same time**, without their build
outputs colliding. Each WebSocket session that calls `run_flutter`
gets its own snapshot of the origin on disk; Flutter's cwd points at
the snapshot, and every write it does (`.dart_tool/`, `build/`,
`ios/Pods/`, `android/.gradle/`, `pubspec.lock`, …) lands inside that
snapshot. When the session ends (WS close, `destroy_session`, or the
server restarts) the snapshot is removed.

The client protocol is unchanged. `run_flutter` still accepts
`projectId` **or** `projectPath` exactly as before, and the response
still returns the original `projectPath`. Two new additive fields —
`workspacePath` and `workspaceIsolated` — are appended for
observability; older clients ignore them.

### Configuration

Add an optional top-level `workspace` block to `flutter-projects.json`:

```jsonc
{
  "workspace": {
    "root": "./.session-workspaces",  // absolute or relative to server dir
    "mode": "copy",                    // "copy" (default) | "shared"
    "snapshotTimeoutMs": 120000,       // abort a snapshot that exceeds this
    "excludeDirs":  [ "custom/heavy/dir" ],
    "excludeFiles": [ "custom/generated.txt" ]
  },
  "projects": [
    { "id": "small-app", "path": "/srv/small-app" },
    { "id": "shared-mode", "path": "/srv/legacy", "workspace": { "mode": "shared" } }
  ]
}
```

Modes:

- **`copy`** *(default)* — full snapshot per session. Source files
  (`lib/`, `test/`, `assets/`, platform folders minus their build
  caches, `pubspec.yaml`, `pubspec.lock`) are copied; the mutable
  build directories start empty so `flutter run` / `pub get` /
  CocoaPods / Gradle regenerate them cleanly inside the snapshot.
  Under the hood the server calls `fs.cpSync`, which forwards to
  `copy_file_range` on Linux, `clonefile` on macOS APFS, and
  `CopyFileEx` on Windows — very fast in practice.
- **`shared`** — no isolation. The session uses the origin path as
  its cwd (legacy behaviour). Provide this per-project when you want
  a specific checkout treated as a single-tenant scratch space.

The default exclude list already covers the mutable state produced by
Flutter, Dart, pub, CocoaPods, Gradle, and Xcode. Extend it with
`excludeDirs` / `excludeFiles` only when your project has extra heavy
generated artefacts on the source side.

### Lifecycle

1. First `run_flutter` on a session **prepares** a snapshot under
   `<root>/<sessionId>/`.
2. Subsequent `run_flutter` calls on the same session **reuse** that
   snapshot, so hot-restart / re-run keep their pub cache warm.
3. Session close (WS close, `destroy_session`, network drop, server
   killing an inactive session) **releases** the snapshot.
4. On server startup, `reapOrphans()` deletes any snapshot dir left
   over from a crashed prior process — no leftovers ever survive a
   restart.

### Operational notes

- Snapshot root should live on the **same filesystem** as the origin
  projects for the fastest copy path (APFS/reflink and
  `copy_file_range` only work within one volume).
- The runner announces the isolation state via a `flutter_output`
  message right after `flutter_run_started`, so the extension console
  shows both the origin and the snapshot path — makes debugging
  "which cwd is flutter actually in?" trivial.

## WebSocket API

### Connection

Connect to `ws://localhost:8080`. Upon connection, you'll receive a session ID:

```json
{
  "type": "connected",
  "success": true,
  "data": {
    "session_id": "uuid-here",
    "message": "Connected to Android Emulator Control Server"
  }
}
```

### Message Format

All messages are JSON objects with a `type` field:

```json
{
  "type": "message_type",
  "requestId": "optional-correlation-id",
  ...other fields
}
```

### Available Commands

#### Create Session (Recommended)

The primary way to get an emulator bound to your session:

```json
{
  "type": "create_session",
  "device": "Pixel_5_API_30",
  "options": {
    "noSnapshot": false,
    "wipeData": false
  }
}
```

Response:
```json
{
  "type": "session_created",
  "success": true,
  "data": {
    "session_id": "uuid-here",
    "device_id": "emulator-5554",
    "emulator_name": "Pixel_5_API_30",
    "already_running": false
  }
}
```

- If the emulator is already running and unassigned, it will be reused
- The emulator is bound to your session
- On disconnect, the emulator is automatically stopped (configurable)

#### Destroy Session

Unbind and optionally stop the emulator:

```json
{
  "type": "destroy_session",
  "kill_emulator": true
}
```

Response:
```json
{
  "type": "session_destroyed",
  "success": true,
  "data": {
    "session_id": "uuid-here",
    "device_id": "emulator-5554",
    "emulator_name": "Pixel_5_API_30",
    "emulator_killed": true
  }
}
```

#### List Available Emulators

```json
{
  "type": "list_emulators"
}
```

Response:
```json
{
  "type": "emulators_list",
  "success": true,
  "data": {
    "avds": ["Pixel_5_API_30", "Pixel_4_API_29"]
  }
}
```

#### Start Emulator

```json
{
  "type": "start_emulator",
  "emulator_name": "Pixel_5_API_30",
  "options": {
    "noSnapshot": false,
    "wipeData": false,
    "noWindow": false,
    "gpuMode": "auto"
  }
}
```

Response:
```json
{
  "type": "emulator_started",
  "success": true,
  "data": {
    "emulator_name": "Pixel_5_API_30",
    "device_id": "emulator-5554",
    "pid": 12345
  }
}
```

#### Stop Emulator

```json
{
  "type": "stop_emulator",
  "device_id": "emulator-5554"
}
```

#### List Connected Devices

```json
{
  "type": "list_devices"
}
```

Response:
```json
{
  "type": "devices_list",
  "success": true,
  "data": {
    "devices": [
      { "id": "emulator-5554", "status": "device" },
      { "id": "192.168.1.100:5555", "status": "device" }
    ]
  }
}
```

#### Assign Device to Session

```json
{
  "type": "assign_device",
  "device_id": "emulator-5554"
}
```

#### Execute ADB Command

```json
{
  "type": "adb_command",
  "device_id": "emulator-5554",
  "command": "shell input text hello"
}
```

Response:
```json
{
  "type": "adb_result",
  "success": true,
  "data": {
    "device_id": "emulator-5554",
    "command": "shell input text hello",
    "output": ""
  }
}
```

#### Execute Shell Command

Shorthand for shell commands (automatically prepends `shell` if needed):

```json
{
  "type": "shell_command",
  "device_id": "emulator-5554",
  "command": "input tap 500 500"
}
```

#### Install APK

```json
{
  "type": "install_apk",
  "device_id": "emulator-5554",
  "apk_path": "/path/to/app.apk"
}
```

#### Take Screenshot

```json
{
  "type": "screenshot",
  "device_id": "emulator-5554",
  "local_path": "/path/to/screenshot.png"
}
```

#### Reboot Device

```json
{
  "type": "reboot",
  "device_id": "emulator-5554",
  "mode": "system"
}
```

Modes: `system`, `bootloader`, `recovery`

#### Get Session Info

```json
{
  "type": "get_session"
}
```

#### Server Statistics

```json
{
  "type": "server_stats"
}
```

#### Ping/Pong

```json
{
  "type": "ping"
}
```

### Using Request IDs

All commands support an optional `requestId` for correlation:

```json
{
  "type": "list_devices",
  "requestId": "req-123"
}
```

The response will include the same `requestId`:

```json
{
  "type": "devices_list",
  "success": true,
  "requestId": "req-123",
  "data": { ... }
}
```

## HTTP Endpoints

- `GET /health` - Health check endpoint
- `GET /stats` - Session statistics

## Architecture

```
adb-emulator-server/
├── server.js           # WebSocket server entry point
├── adb.js              # ADB command wrapper
├── emulator.js         # Emulator control functions
├── emulatorManager.js  # Emulator lifecycle & session binding
├── sessionManager.js   # Client session management
├── package.json
└── README.md
```

### Modules

- **server.js**: WebSocket server with message routing and handlers
- **adb.js**: Async wrapper around ADB commands using child_process
- **emulator.js**: Functions to start/stop/manage Android emulators
- **emulatorManager.js**: Manages emulator-to-session binding and lifecycle
- **sessionManager.js**: Manages client sessions and device mappings

## Example Client (JavaScript)

```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.onopen = () => {
  console.log('Connected');
  
  // Create session with emulator
  ws.send(JSON.stringify({
    type: 'create_session',
    device: 'Pixel_5_API_30',
    requestId: 'session-1'
  }));
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log('Received:', message);
  
  if (message.type === 'session_created' && message.success) {
    console.log(`Session created with device: ${message.data.device_id}`);
    
    // Send a tap command (device_id is auto-bound to session)
    ws.send(JSON.stringify({
      type: 'shell_command',
      command: 'input tap 500 500',
      requestId: 'tap-1'
    }));
  }
};

ws.onerror = (error) => {
  console.error('WebSocket error:', error);
};

ws.onclose = () => {
  console.log('Disconnected - emulator will be stopped automatically');
};
```

## Example Client (Python)

```python
import asyncio
import websockets
import json

async def main():
    async with websockets.connect('ws://localhost:8080') as ws:
        # Receive connection message
        response = await ws.recv()
        print(f"Connected: {response}")
        
        # Create session with emulator
        await ws.send(json.dumps({
            "type": "create_session",
            "device": "Pixel_5_API_30",
            "requestId": "session-1"
        }))
        
        # Wait for session_creating acknowledgment
        response = await ws.recv()
        print(f"Creating: {response}")
        
        # Wait for session_created
        response = await ws.recv()
        session = json.loads(response)
        print(f"Session created: {session}")
        
        if session.get("success"):
            # Send ADB command (device auto-bound to session)
            await ws.send(json.dumps({
                "type": "shell_command",
                "command": "getprop ro.build.version.sdk",
                "requestId": "sdk-1"
            }))
            
            response = await ws.recv()
            print(f"SDK Version: {response}")

asyncio.run(main())
# Note: Emulator will be stopped automatically when connection closes
```

## Security Considerations

- The server blocks potentially dangerous shell commands (rm -rf, command injection)
- Each session can only control devices explicitly assigned to it
- Consider adding authentication for production use
- Use TLS (wss://) in production environments

## Troubleshooting

### ADB not found
Ensure ADB is installed and in your PATH:
```bash
adb version
```

### Emulator not starting
1. Check available AVDs: `emulator -list-avds`
2. Ensure you have enough disk space and RAM
3. Check the server logs for detailed error messages

### Connection refused
1. Verify the server is running on the expected port
2. Check firewall settings
3. Ensure no other service is using the port

## License

MIT
