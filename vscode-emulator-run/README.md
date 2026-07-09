# Emulator Stream Run (VS Code / Cursor extension)

Run a Flutter app on a **remote** emulator/simulator with one click, BrowserStack-style. Your laptop only needs VS Code + this extension: it never runs `flutter`, `adb`, or `xcodebuild`.

**Per-platform, fully offline packages.** Install the `.vsix` built for your OS/arch — it contains the streaming viewer and all native dependencies for that platform only. No downloads, no GitHub releases, no first-run installer. Each package is self-contained and typically tens of MB instead of a 300 MB universal bundle.

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

**Install the `.vsix` built for your platform:**

| Your machine | VSIX file |
| ------------ | --------- |
| Windows 64-bit | `emulator-stream-run-<version>-win32-x64.vsix` |
| Windows ARM64 | `emulator-stream-run-<version>-win32-arm64.vsix` |
| Mac Apple Silicon | `emulator-stream-run-<version>-darwin-arm64.vsix` |
| Mac Intel | `emulator-stream-run-<version>-darwin-x64.vsix` |
| Linux x64 | `emulator-stream-run-<version>-linux-x64.vsix` |
| Linux ARM64 | `emulator-stream-run-<version>-linux-arm64.vsix` |

```bash
code --install-extension emulator-stream-run-<version>-win32-x64.vsix
```

Then set your remote server in workspace settings:

```json
{
  "emulatorStreamRun.server":      "ws://REMOTE.HOST:8080",
  "emulatorStreamRun.projectPath": "/absolute/path/on/remote"
}
```

Open any workspace and press **F5**. The bundled streaming viewer launches immediately — no network download step.

Installing a `.vsix` built for a different platform (e.g. a Mac build on Windows) will fail with a clear error. Use the matching file from the table above.

## Developer-machine dev workflow (extension authors)

If you are *editing* the extension source, install by running the source tree instead of a `.vsix`:

```bash
cd vscode-emulator-run
npm install         # postinstall publishes the streaming viewer into vendor/desktop-app
```

`scripts/bootstrap.js`:
1. Runs `dotnet publish -c Release -r <current-platform>` against `../EmulatorDesktopApp/`.
2. Copies the publish output into `vendor/desktop-app/`.
3. Writes `vendor/desktop-app/BUILD_INFO.json` so the extension can detect stale bundles at F5 time.
4. Symlinks `vscode-emulator-run/` into every detected `~/.vscode/extensions/` (and `~/.cursor/extensions/`, `.vscode-insiders`, …).

Rebuild the streaming viewer after C# edits:

- Command Palette → `Emulator Stream: Rebuild Desktop App`, or
- `npm run bootstrap`.

If the extension detects that the running viewer was built without the current feature contract, F5 shows a warning notification with a one-click "Rebuild Desktop App (dev mode)" action.

### Prerequisites for dev mode

* **.NET 10 SDK** — for `dotnet publish`. Install: `brew install --cask dotnet-sdk` / `winget install Microsoft.DotNet.SDK.10`.
* **Node.js ≥ 18**.

## Building `.vsix` for distribution

Each command produces **one** platform-specific, fully offline package:

```bash
cd vscode-emulator-run

# Current host platform:
npm run package

# A specific target:
npm run package:win32-x64
npm run package:win32-arm64
npm run package:darwin-arm64
npm run package:darwin-x64
npm run package:linux-x64
npm run package:linux-arm64

# Every supported target in one go (from a Mac/Linux build machine):
npm run package:all
```

Each invocation:
1. Runs `dotnet publish -r <rid>` for that target only.
2. Bundles Windows FFmpeg DLLs automatically for `win-*` targets.
3. Copies the publish output into `vendor/desktop-app/` (flat layout — only that platform).
4. Writes `vendor/desktop-app/BUILD_INFO.json`.
5. Runs `vsce package --target <platform>` → `dist/emulator-stream-run-<version>-<target>.vsix`.

Each invocation prints a **size report** (folders ≥ 1 MB, files ≥ 500 KB, pruned files) and writes the VSIX to `dist/`.

Typical compressed VSIX sizes after optimization:

| Platform | Approx. VSIX size | Notes |
| -------- | ----------------- | ----- |
| macOS arm64 | ~18 MB | No FFmpeg bundled (uses system libs at runtime on Mac dev; streaming decode path) |
| Windows x64 | ~57 MB | Includes minimal FFmpeg decode DLLs (~108 MB uncompressed) + Avalonia/Skia |

Windows is larger because FFmpeg H.264 decode libraries must ship inside the VSIX (macOS/Linux resolve FFmpeg from the host).

### Cross-compiling from macOS

.NET SDK can cross-publish Windows/Linux RIDs from a Mac. Running `npm run package:all` on a Mac produces all six `.vsix` files in a few minutes.

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
| `emulatorStreamRun.desktopAppPath` | *(empty)* | Advanced: absolute path to an EmulatorDesktopApp binary. Overrides the bundled copy inside the `.vsix`. |
| `emulatorStreamRun.desktopAppRid` | *(empty)* | Advanced: force a specific .NET RID. Empty = auto-detect from `process.platform` / `process.arch`. |
| `emulatorStreamRun.openStreamWindow` | `true` | Open the streaming window on `flutter_ready`. |
| `emulatorStreamRun.stopGracePeriodMs` | `5000` | Wait window for the remote Flutter to exit gracefully before SIGTERM. |

Nothing about local Flutter paths, project paths, or flavor discovery — all of that lives on the remote host now.

## Troubleshooting

Run **`Emulator Stream: Diagnose Desktop App`** from the Command Palette.

### `Desktop app: (not bundled — stream window will not open) [missing]`

The `.vsix` was built for a **different platform** or packaged without the desktop app.

Run the doctor command. Look for `likelyWrongPlatform` — it tells you which platform the bundled binary was built for vs. your host.

Fix: install the correct `.vsix` for your machine (see the table in [Developer-machine install](#developer-machine-install-end-user)), or rebuild:

```bash
npm run package:win32-x64    # on Windows x64
npm run package:darwin-arm64   # on Apple Silicon Mac
```

`npm run package:all` on a Mac build machine produces all six platform packages in one pass.

### Windows: `Unable to find FFMPEG binaries`

The Windows `.vsix` was built without FFmpeg DLLs (usually an old package from before the cross-compile fix). Rebuild with `npm run package:win32-x64` — the packaging script bundles `ffmpeg/win-x64/*.dll` automatically.

### Extension activates but F5 never starts flutter

The doctor covers the local side; server-side issues (device not found, project path missing) surface as WebSocket errors in the standard debug console. Look for lines prefixed `[remote]` — those come from the Node server on the remote host.

## Verifying the server side without a client

Any WebSocket client can probe the new endpoints:

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
│   ├── extension.ts             activation + commands + status bar + installer singleton
│   ├── debugAdapter.ts          inline DAP adapter (F5 entry point)
│   ├── orchestrator.ts          device→(project|path)→run_flutter→attach hand-off
│   ├── serverClient.ts          long-lived WS client (all remote calls)
│   ├── settings.ts              config resolution
│   ├── devicePicker.ts          device Quick Pick
│   ├── projectPicker.ts         project + flavor Quick Picks (both registered & ad-hoc)
│   ├── streamProcess.ts         spawn the streaming viewer
│   ├── desktopAppFreshness.ts   BUILD_INFO.json parse + stale-bundle detection
│   ├── desktopAppManifest.ts    PINNED_MANIFEST (legacy; unused in offline per-platform model)
│   ├── desktopAppInstaller.ts   bundled-binary resolver (offline-only at F5 time)
│   ├── doctorCommand.ts         Command Palette → diagnose the installer
│   └── rebuildCommand.ts        Command Palette → rerun bootstrap (dev mode only)
├── scripts/
│   ├── bootstrap.js             dev workflow: publish + copy + symlink
│   ├── package.js               per-platform offline vsix packager
│   └── publish-desktop-app.js   optional remote-release helper (not used by default packaging)
├── vendor/desktop-app/          (auto-generated) single-platform publish output + BUILD_INFO.json
├── dist/                        (auto-generated) per-platform .vsix files
└── package.json
```
