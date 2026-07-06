# Emulator Stream Run (VS Code / Cursor extension)

Run a Flutter app on a **remote** emulator/simulator with one click, BrowserStack-style. Your laptop only needs VS Code + this extension: it never runs `flutter`, `adb`, or `xcodebuild`.

## Architecture (thin-client model)

```
   ┌──────────────────────────────────────────────┐
   │  Developer machine                           │
   │                                              │
   │    VS Code + this extension    (thin client) │
   │       │                                      │
   │       │  ws://REMOTE:8080                    │
   │       ▼                                      │
   │    EmulatorDesktopApp          (streaming    │
   │    (Avalonia .NET, bundled)     window +     │
   │                                 touch input) │
   └──────────────────────────────────────────────┘
                       │
                       │  WebSocket + WebRTC
                       ▼
   ┌──────────────────────────────────────────────┐
   │  Remote machine  (does ALL the heavy lifting)│
   │                                              │
   │    Gateway server (websocket_nodejs/)        │
   │      • Device catalog (adb, simctl)          │
   │      • Session manager                       │
   │      • FlutterRunnerService                  │
   │      • WebRTC signaling / streaming          │
   │                                              │
   │    Flutter SDK + Android SDK + Xcode         │
   │    Flutter projects (on disk)                │
   │    Android emulators / iOS simulators / real │
   │    devices                                   │
   └──────────────────────────────────────────────┘
```

The developer machine has **zero** dependencies beyond:
* VS Code / Cursor
* This extension (which auto-bundles the desktop-app streaming viewer)
* .NET runtime (needed by the streaming viewer — installable in seconds)

Everything else — Flutter SDK, Android SDK, Xcode, adb, simctl, the Flutter project source, the device — lives on the **remote** host.

## One-time server setup (remote machine)

Edit `websocket_nodejs/adb-emulator-server/flutter-projects.json` to register the Flutter projects this server should expose to clients:

```json
{
  "projects": [
    {
      "id": "elm-employee-hub",
      "name": "ELM Employee Hub",
      "path": "/Users/ci/projects/elm-employee-hub",
      "flutterPath": "flutter"
    }
  ]
}
```

`flavors` is optional — if omitted, the server auto-derives them from the project's `.vscode/launch.json` (any `type: "dart"` config) and its `lib/main_*.dart` files. Explicitly listing them looks like:

```json
"flavors": [
  { "name": "development", "target": "lib/main_development.dart", "flavor": "development" },
  { "name": "production",  "target": "lib/main_production.dart",  "flavor": "production", "args": ["--dart-define=API=prod"] }
]
```

Start the gateway server as usual:

```bash
cd websocket_nodejs/adb-emulator-server
npm install
node server.js
```

## Developer-machine setup

```bash
cd vscode-emulator-run
npm install                # postinstall publishes the streaming viewer into vendor/desktop-app
```

Then either:
- **Symlink into VS Code extensions** (`~/.vscode/extensions/…`), or
- Run the extension from the "Extension Development Host" (open this folder in VS Code, hit F5 on the extension itself).

Configure the remote host in your **workspace** settings.json:

```json
{
  "emulatorStreamRun.server": "ws://REMOTE.HOST:8080"
}
```

Now open **any workspace** — no Flutter, no pubspec required — and hit F5, or run `Emulator Stream: Run on remote device` from the command palette.

## What F5 does end-to-end

1. Opens a persistent WebSocket to the remote gateway server.
2. `list_projects` → Quick Pick over remote projects (skipped if only one, or if pinned in `launch.json`).
3. Quick Pick over flavors of the picked project (skipped if only one, or pinned).
4. `get_devices` → Quick Pick over remote devices (in-use ones are filtered out).
5. `create_session` — reserves the picked device on this WS.
6. `run_flutter` — server spawns `flutter run -d <device> --target … --flavor …` **on the remote host**. Stdout/stderr streams back into the VS Code Debug Console as it arrives.
7. When the server emits `flutter_ready`, launches the local `EmulatorDesktopApp` with `--session-id <sameSessionId>`.
8. The streaming window connects to the remote server, calls `attach_session` to piggy-back on the reservation, negotiates WebRTC, and displays the live view.
9. Touch/keyboard input in the streaming window is forwarded to the remote device.

## Stop

Click VS Code's Stop button, or close the streaming window. Both:
1. Server sends `q` to the remote `flutter run` (graceful quit) → SIGTERM after `stopGracePeriodMs`.
2. Extension SIGTERMs the local streaming window if it's still open.
3. `destroy_session` releases the device on the remote.

If the extension crashes, the server detects the WebSocket close and kills the remote Flutter subprocess automatically — no dangling `flutter run` processes.

## `launch.json` reference

The extension works without any `launch.json` — F5 in an empty workspace just prompts. If you want to pin things:

```jsonc
{
  "type": "emulator-stream",
  "request": "launch",
  "name": "Emulator Stream",

  "server":     "ws://REMOTE:8080",     // overrides emulatorStreamRun.server
  "projectId":  "elm-employee-hub",     // skip project picker (id from flutter-projects.json)
  "flavor":     "development",          // skip flavor picker (name from the flavors list)
  "device":     "emulator-5554",        // skip device picker (id from get_devices)
  "flutterArgs": ["--dart-define=STAGE=1"],
  "openStreamWindow": true
}
```

## Extension settings

| Setting | Default | Purpose |
| ------- | ------- | ------- |
| `emulatorStreamRun.server` | `ws://127.0.0.1:8080` | Remote gateway server URL. Prefer `127.0.0.1` on loopback (Node resolves `localhost` to IPv6 first). |
| `emulatorStreamRun.desktopAppPath` | *(empty)* | Absolute path to the streaming viewer binary. Empty = use the copy bundled by `npm run bootstrap`. |
| `emulatorStreamRun.openStreamWindow` | `true` | Open the streaming window on `flutter_ready`. |
| `emulatorStreamRun.stopGracePeriodMs` | `5000` | Wait window for the remote Flutter to exit gracefully before SIGTERM. |

Nothing about local Flutter paths, project paths, or flavor discovery — all of that lives on the remote host now.

## Verifying the server side without a client

Any WebSocket client can probe the new endpoints:

```bash
# Show configured projects
wscat -c ws://REMOTE:8080
> {"type":"list_projects","requestId":"a"}

# Show devices with in_use annotations
> {"type":"get_devices","requestId":"b"}
```

## Layout

```
vscode-emulator-run/
├── src/
│   ├── extension.ts        activation + commands + status bar
│   ├── debugAdapter.ts     inline DAP adapter (F5 entry point)
│   ├── orchestrator.ts     device→project→run_flutter→attach hand-off
│   ├── serverClient.ts     long-lived WS client (all remote calls)
│   ├── settings.ts         config resolution
│   ├── devicePicker.ts     device Quick Pick
│   ├── projectPicker.ts    project + flavor Quick Picks
│   └── streamProcess.ts    spawn the local streaming viewer
├── scripts/bootstrap.js    dotnet-publishes the viewer + symlinks the extension
├── vendor/desktop-app/     (auto-generated) published viewer binary
└── package.json
```
