# Emulator Stream Run (VS Code / Cursor extension)

Run a Flutter app on a remote emulator/simulator with **one click**. The extension is a thin orchestrator that lives inside VS Code: it picks a device from your running gateway server, spawns `flutter run` locally, and launches the existing `EmulatorDesktopApp` (Avalonia .NET) to display the live stream. That's it.

## The 3-component architecture

```
   ┌────────────────────────┐
   │  Gateway server        │  ws://<host>:8080  ← you run this
   │  (websocket_nodejs/)   │
   └────────┬───────────────┘
            │
            │ WebRTC + WS control channel
            │
   ┌────────▼───────────────┐
   │  EmulatorDesktopApp    │  ← owns session, WebRTC, freeze recovery,
   │  (Avalonia .NET)       │    stream restart, control mapping — the
   │                        │    battle-tested client, unchanged.
   └────────▲───────────────┘
            │
            │ launched with:
            │   --server ws://... --device <id> --auto-start
            │
   ┌────────┴───────────────┐
   │  VS Code extension     │  ← device picker, `flutter run`, spawn the
   │  (vscode-emulator-run/)│    desktop app, unwind on Stop.
   └────────────────────────┘
```

The extension **only** does:

1. Short WebSocket to the server → `get_devices` → close socket.
2. Quick Pick to choose the device (auto-selects if just one).
3. `flutter run -d <id>` in your Flutter project.
4. Spawn `EmulatorDesktopApp --server X --device Y --auto-start`.
5. On Stop → `q` to Flutter (grace period → SIGTERM → SIGKILL) and SIGTERM the desktop app.

Everything session-, WebRTC-, and streaming-related is owned by the desktop app.

When launched with `--auto-start`, the desktop app runs in **headless mode**: its main control window is never created, only the streaming window is shown. Closing the streaming window quits the app.

## Install (one command, one time)

```bash
cd vscode-emulator-run
npm install
```

`npm install` runs a bootstrap script that:

1. `dotnet publish -c Release -r <your-rid> --self-contained false` on `../EmulatorDesktopApp/` and copies the output into `vendor/desktop-app/`. The extension always launches this bundled copy — no PATH configuration, no manual builds.
2. Compiles the extension itself (`tsc`).
3. Symlinks this folder into every VS Code / VS Code Insiders / VS Code OSS / Cursor extensions folder it finds on your machine.

Reload each editor once (⌘⇧P → **Developer: Reload Window**). The extension is then available in every window.

**Prerequisites:** `dotnet` (10.0+) on `PATH`. That's the only extra tool — everything else is bundled.

## Use it

1. Start the gateway server (`websocket_nodejs/`) somewhere reachable.
2. Open your Flutter project in VS Code (or Cursor). The workspace root — or any subfolder — must contain a `pubspec.yaml`.
3. Either:
   - Click **▶ Emulator Stream** in the status bar (bottom-left), **or**
   - Command Palette → **Emulator Stream: Run Flutter on remote device**, **or**
   - Press **F5** and pick *Emulator Stream* the first time (VS Code writes a minimal `launch.json` automatically).
4. **Pick a flavor** from the Quick Pick (skipped if only one). See _Flavor discovery_ below.
5. **Pick a device** from the Quick Pick. (Skipped if only one is available.)
6. Watch the Debug Console — Flutter output streams in. When the app is ready, the streaming window opens beside your editor.
7. Press **■ Stop** in the debug toolbar. Flutter quits, the streaming window closes, the server-side session is released.

**No CLI to install. No `launch.json` to author. No paths to configure.**

## Flavor discovery

The extension automatically finds every way you already run your Flutter app and offers them all as picks.

Sources, in order of preference:

1. **Existing `launch.json` entries** with `type: "dart"`. Their `program` becomes `--target`, their `--flavor` becomes `--flavor`, other args are forwarded verbatim.
2. **`lib/main_*.dart` files** in your Flutter project. Everything after `main_` becomes the flavor name (`main_development.dart` → `development`).
3. If neither exists, we just run `flutter run` with no flavor.

You can reference a discovered flavor by name in an emulator-stream launch config with `configName`:

```jsonc
{
  "type": "emulator-stream",
  "request": "launch",
  "name": "Emulator Stream: development",
  "configName": "development"
}
```

Missing `target`/`flavor`/`flutterArgs` are filled in from the discovered flavor.

## Settings

| Setting                                | Default              | Notes                                                                                       |
| -------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| `emulatorStreamRun.server`             | `ws://127.0.0.1:8080`| Gateway server URL. Prefer `127.0.0.1` — Node 18+ resolves `localhost` to IPv6 first.       |
| `emulatorStreamRun.desktopAppPath`     | *(bundled)*          | Advanced: absolute path to a custom `EmulatorDesktopApp` binary.                            |
| `emulatorStreamRun.flutterPath`        | `flutter`            | Path to the flutter executable.                                                             |
| `emulatorStreamRun.flutterProject`     | *(workspace root)*   | Path to the Flutter project. Empty = workspace root.                                        |
| `emulatorStreamRun.openStreamWindow`   | `true`               | Set to `false` to run Flutter only (no streaming window).                                    |
| `emulatorStreamRun.stopGracePeriodMs`  | `5000`               | How long to wait for Flutter's `q` before SIGTERM.                                          |

## Troubleshooting

- **`Could not fetch devices from ws://...`** — the gateway server isn't reachable. Check it's running and use `127.0.0.1` instead of `localhost` in the setting.
- **`EmulatorDesktopApp binary not found`** — the bootstrap step skipped or failed. Run `npm run bootstrap` from the extension folder and check the `dotnet publish` output.
- **`Device "X" was not returned by the server`** — the pinned device id in `launch.json` no longer matches. Remove it to get the Quick Pick, or update it to a currently online device.
- **Streaming window is blank** — the Avalonia desktop app has its own log panel; open it (bottom tab in its window) to see connection/WebRTC/decoder messages. Everything server-side (session, ICE, frame stats) is logged there, not in the VS Code Debug Console.

## Dev / testing

```bash
npm run bootstrap             # (re-)publish desktop app + compile + symlink
npm run compile               # tsc only
node scripts/smoke-flavors.js # headless flavor-discovery test
```
