# Emulator Stream Run (VS Code / Cursor extension)

Run a Flutter app on a **remote** emulator/simulator with one click, BrowserStack-style. Your laptop only needs VS Code + this extension: it never runs `flutter`, `adb`, or `xcodebuild`.

**One `.vsix` per platform, fully offline.** Every release ships as a separate
per-platform vsix (`win32-x64`, `darwin-arm64`, …). Each vsix contains **only**
the streaming-viewer binary + native dependencies for its own platform, so
installs stay modest (~20–60 MB) and the extension launches without any
runtime download, cache, or external installer. VS Code enforces
platform-vsix matching at install time.

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
* The platform-specific `.vsix` for this machine

Everything else — Flutter SDK, Android SDK, Xcode, adb, simctl, the Flutter project source, the device — lives on the **remote** host.

## One-time server setup (remote machine)

Two ways to point the extension at Flutter projects on the remote host, use either or both:

### A. Register projects in `flutter-projects.json` (production / shared setup)

Edit `websocket_nodejs/adb-emulator-server/flutter-projects.json`:

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

`flavors` is optional — the server auto-derives them from the project's `.vscode/launch.json` (`type: "dart"` configs) and `lib/main_*.dart` files. Explicit listing:

```json
"flavors": [
  { "name": "development", "target": "lib/main_development.dart", "flavor": "development" },
  { "name": "production",  "target": "lib/main_production.dart",  "flavor": "production", "args": ["--dart-define=API=prod"] }
]
```

### B. Point at a remote path directly (dynamic, no server-side config)

If you don't want to edit `flutter-projects.json`, set the path on the client:

```json
// .vscode/settings.json on the developer machine
{
  "emulatorStreamRun.server":       "ws://REMOTE:8080",
  "emulatorStreamRun.projectPath":  "/Users/ci/projects/some-feature-branch"
}
```

or per-run in `launch.json`:

```json
{
  "type": "emulator-stream",
  "request": "launch",
  "name": "Feature branch",
  "projectPath": "/Users/ci/projects/some-feature-branch",
  "flavor": "development"
}
```

The server treats that path as if it were a registered project — same flavor auto-discovery, same `flutter run` command line. Nothing needs to be pre-declared on the server side, which is handy when the remote checkout changes often or every developer has their own working copy.

### Start the gateway server

```bash
cd websocket_nodejs/adb-emulator-server
npm install
node server.js
```

## Developer-machine install (end user)

Pick the `.vsix` that matches YOUR host:

| Your OS + arch                | vsix file                                             |
| ----------------------------- | ----------------------------------------------------- |
| Windows 64-bit                | `emulator-stream-run-<version>-win32-x64.vsix`        |
| Windows on ARM (Surface Pro)  | `emulator-stream-run-<version>-win32-arm64.vsix`      |
| macOS Intel                   | `emulator-stream-run-<version>-darwin-x64.vsix`       |
| macOS Apple Silicon (M1/M2/…) | `emulator-stream-run-<version>-darwin-arm64.vsix`     |
| Linux 64-bit                  | `emulator-stream-run-<version>-linux-x64.vsix`        |
| Linux ARM64                   | `emulator-stream-run-<version>-linux-arm64.vsix`      |

```bash
code   --install-extension emulator-stream-run-<version>-<target>.vsix
# or
cursor --install-extension emulator-stream-run-<version>-<target>.vsix
```

(You can also drag the `.vsix` into the VS Code / Cursor Extensions view.)

Then in your workspace settings:

```json
{
  "emulatorStreamRun.server":      "ws://REMOTE.HOST:8080",
  "emulatorStreamRun.projectPath": "/absolute/path/on/remote"
}
```

Open any workspace and press **F5**. Everything the streaming viewer needs is
inside the `.vsix` — no download, no first-run install, no cache, no external
tooling required.

**Wrong-platform vsix?** VS Code refuses to install a `win32-x64` vsix on a Mac
(and vice versa), with a clear "This extension is not compatible with this OS"
error. If somehow a mismatched build ends up on the machine, F5 fails
immediately with a diagnostics dump pointing at the correct vsix name.

## Developer-machine dev workflow (extension authors)

If you are *editing* the extension source, install by running the source tree instead of a `.vsix`:

```bash
cd vscode-emulator-run
npm install         # postinstall publishes the streaming viewer into vendor/desktop-app
```

`scripts/bootstrap.js`:
1. Runs `dotnet publish -c Release -r <current-platform>` against `../EmulatorDesktopApp/`.
2. Copies the publish output into `vendor/desktop-app/<current-rid>/`.
3. Writes `BUILD_INFO.json` so the extension can detect stale bundles at F5 time.
4. Symlinks `vscode-emulator-run/` into every detected `~/.vscode/extensions/` (and `~/.cursor/extensions/`, `.vscode-insiders`, …).

Rebuild the streaming viewer after C# edits:

- Command Palette → `Emulator Stream: Rebuild Desktop App`, or
- `npm run bootstrap`.

If the extension detects that the running viewer was built without the current feature contract, F5 shows a warning notification with a one-click "Rebuild Desktop App (dev mode)" action.

### Prerequisites for dev mode

* **.NET 10 SDK** — for `dotnet publish`. Install: `brew install --cask dotnet-sdk` / `winget install Microsoft.DotNet.SDK.10`.
* **Node.js ≥ 18**.

## Building `.vsix` for distribution (maintainers)

One `.vsix` per platform, opt in per target:

```bash
cd vscode-emulator-run

# Current host only (fast):
npm run package                       # → dist/emulator-stream-run-<v>-<host-target>.vsix

# A specific target:
npm run package:win32-x64             # → dist/emulator-stream-run-<v>-win32-x64.vsix
npm run package:win32-arm64
npm run package:darwin-x64
npm run package:darwin-arm64
npm run package:linux-x64
npm run package:linux-arm64

# Every supported target in one invocation:
npm run package:all                   # → six .vsix files, one per platform
```

Each `package:*` invocation:

1. Wipes `vendor/desktop-app/` so nothing from a previous target leaks.
2. Runs `dotnet publish -c Release -r <rid>` against `../EmulatorDesktopApp/`.
3. For `win-*` RIDs, ensures the Gyan codexffmpeg 8.1 DLLs are present (either
   from the MSBuild target, or fetched by `scripts/ensure-win-ffmpeg.js` as a
   fallback).
4. Writes `vendor/desktop-app/<rid>/BUILD_INFO.json` with the git sha + feature
   contract.
5. Runs `vsce package --target <vsce-target>` so the resulting vsix is tagged
   for that platform.

.NET SDK supports cross-RID publishing (`dotnet publish -r win-x64` on a Mac), so
one macOS/Linux build machine can produce every artefact.

`.vscodeignore` guarantees `vendor/desktop-app/` is INCLUDED and source/tests/scripts/node_modules are EXCLUDED.

## What F5 does end-to-end

1. Opens a persistent WebSocket to the remote gateway server.
2. `get_devices` → Quick Pick over remote devices (in-use ones are filtered out; skipped if `device` is pinned).
3. **Project resolution** — one of:
   - `projectPath` is set (settings or launch.json) → `list_flavors <projectPath>` for auto-discovery, then flavor Quick Pick.
   - `projectId` is set → look it up in the server's `list_projects` response, then flavor Quick Pick.
   - Neither → `list_projects` → project Quick Pick → flavor Quick Pick.
4. `create_session` — reserves the picked device on this WS.
5. `run_flutter` — server spawns `flutter run -d <device> --target … --flavor …` **on the remote host**, cwd = the project path (from `flutter-projects.json` or the dynamic `projectPath`). Stdout/stderr streams back into the VS Code Debug Console as it arrives.
6. When the server emits `flutter_ready`, the extension launches its bundled `EmulatorDesktopApp` with `--session-id <sameSessionId>`.
7. The streaming window connects to the remote server, calls `attach_session` to piggy-back on the reservation, negotiates WebRTC, and displays the live view.
8. Touch/keyboard input in the streaming window is forwarded to the remote device.

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

  "server":       "ws://REMOTE:8080",              // overrides emulatorStreamRun.server
  "projectPath":  "/Users/ci/projects/elm",        // dynamic path on remote (skips project picker)
  //  … OR use a registered id from flutter-projects.json instead:
  //  "projectId":  "elm-employee-hub",
  "flutterPath": "flutter",                         // optional; only used with projectPath
  "flavor":      "development",                     // skip flavor picker
  "device":      "emulator-5554",                   // skip device picker
  "flutterArgs": ["--dart-define=STAGE=1"],
  "openStreamWindow": true
}
```

## Extension settings

| Setting | Default | Purpose |
| ------- | ------- | ------- |
| `emulatorStreamRun.server` | `ws://127.0.0.1:8080` | Remote gateway server URL. Prefer `127.0.0.1` on loopback (Node resolves `localhost` to IPv6 first). |
| `emulatorStreamRun.projectPath` | *(empty)* | Absolute path on the **remote** machine to a Flutter checkout. When set, bypasses the server's `flutter-projects.json` entirely. Mutually exclusive with `projectId`. |
| `emulatorStreamRun.projectId` | *(empty)* | Pin a registered project id from the server's `flutter-projects.json`. Mutually exclusive with `projectPath`. |
| `emulatorStreamRun.flavor` | *(empty)* | Pin a flavor name for the pinned project. Empty = interactive Quick Pick. |
| `emulatorStreamRun.flutterPath` | *(empty)* | Advanced: `flutter` binary the remote should use for `projectPath` runs. |
| `emulatorStreamRun.desktopAppPath` | *(empty)* | Advanced: absolute path to an `EmulatorDesktopApp[.exe]` binary to launch instead of the bundled one. |
| `emulatorStreamRun.openStreamWindow` | `true` | Open the streaming window on `flutter_ready`. |
| `emulatorStreamRun.stopGracePeriodMs` | `5000` | Wait window for the remote Flutter to exit gracefully before SIGTERM. |

Nothing about local Flutter paths, project paths, or flavor discovery — all of that lives on the remote host now.

## Troubleshooting

### `Desktop app: (missing …)` at F5

You installed the wrong platform-specific `.vsix`. Run **`Emulator Stream: Diagnose Desktop App`** from the Command Palette — the doctor prints exactly which `.vsix` to install (e.g. `emulator-stream-run-*-win32-x64.vsix`) and where the extension looked.

Common causes:

* `.vsix` for another OS/arch got copied over — install the correct one.
* Dev-mode symlink from an older layout — re-run `npm run bootstrap`.
* Partial install / disk corruption — uninstall and reinstall the `.vsix`.

### Extension activates but F5 never actually starts flutter

The doctor covers the local side; server-side issues (device not found, project path missing) surface as WebSocket errors in the standard debug console. Look for lines prefixed `[remote]` — those come from the Node server on the remote host.

## Verifying the server side without a client

Any WebSocket client can probe the endpoints:

```bash
# Show configured projects (from flutter-projects.json)
wscat -c ws://REMOTE:8080
> {"type":"list_projects","requestId":"a"}

# Discover flavors for a dynamic path (ad-hoc, no server config needed)
> {"type":"list_flavors","projectPath":"/Users/ci/projects/elm","requestId":"b"}

# Show devices with in_use annotations
> {"type":"get_devices","requestId":"c"}
```

## Layout

```
vscode-emulator-run/
├── src/
│   ├── extension.ts             activation + commands + status bar
│   ├── debugAdapter.ts          inline DAP adapter (F5 entry point)
│   ├── orchestrator.ts          device→(project|path)→run_flutter→attach hand-off
│   ├── serverClient.ts          long-lived WS client (all remote calls)
│   ├── settings.ts              config resolution + bundled-binary lookup
│   ├── devicePicker.ts          device Quick Pick
│   ├── projectPicker.ts         project + flavor Quick Picks
│   ├── streamProcess.ts         spawn the streaming viewer
│   ├── desktopAppFreshness.ts   BUILD_INFO.json parse + wrong-platform diagnostics
│   ├── doctorCommand.ts         Command Palette → diagnose the bundled binary
│   └── rebuildCommand.ts        Command Palette → rerun bootstrap (dev mode only)
├── scripts/
│   ├── bootstrap.js             dev workflow: publish + copy + symlink
│   ├── package.js               per-platform vsix packager (one target per invocation)
│   └── ensure-win-ffmpeg.js     cross-compile fallback for Windows FFmpeg DLLs
├── vendor/desktop-app/          per-RID subfolder for THIS build's target platform
├── dist/                        (auto-generated) packaged .vsix files
└── package.json
```
