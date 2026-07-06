import { EventEmitter } from 'events';
import { fetchDevices, type DeviceEntry } from './serverClient';
import { pickDevice, UserCancelled, DeviceInUseError } from './devicePicker';
import { FlutterRunner } from './flutterRunner';
import { StreamProcess } from './streamProcess';
import type { ResolvedSettings } from './settings';

/**
 * Single-shot state machine that runs on `launch` and unwinds on `stop`.
 *
 * Architecture (mirrors the user-facing goal):
 *
 *   The gateway server (`websocket_nodejs/`) is running standalone — the
 *   extension never touches it beyond one short-lived `get_devices` call
 *   for the device picker. The EmulatorDesktopApp owns the session, the
 *   WebRTC connection, and the streaming UI. The extension is a thin
 *   orchestrator: pick device, `flutter run`, launch desktop app, stop
 *   both on Stop.
 *
 * Start:
 *   1) Fetch the device list over a short-lived WebSocket, close it.
 *   2) Quick Pick (auto-selects if there's exactly one).
 *   3) `flutter run -d <id>` in the workspace project.
 *   4) When Flutter reports the app is running, spawn the desktop app
 *      with `--server X --device Y --auto-start`. It creates its own
 *      session on its own WebSocket.
 *
 * Stop (Run/Debug Stop, Flutter exit, or desktop app close):
 *   1) `q` to Flutter → wait grace period → SIGTERM → SIGKILL.
 *   2) SIGTERM the desktop app. Its window-close hook runs
 *      `destroy_session`; the socket close would release the device
 *      anyway. SIGKILL after 3s as a hard fallback.
 *   3) Emit 'terminated' so the debug adapter can wrap up.
 */
export interface OrchestratorEvents {
  output: (line: string, category: 'stdout' | 'stderr' | 'console') => void;
  status: (message: string) => void;
  terminated: (info: { reason: string; exitCode?: number | null }) => void;
  error: (err: Error) => void;
}

export class Orchestrator extends EventEmitter {
  private flutter: FlutterRunner | null = null;
  private stream: StreamProcess | null = null;
  private device: DeviceEntry | null = null;
  private stopping = false;
  private terminated = false;

  async start(settings: ResolvedSettings): Promise<void> {
    this.emitStatus('Fetching devices…');
    this.emitLine(`[extension] server=${settings.server}\n`, 'console');

    const picked = await this.discoverAndPickDevice(settings);
    if (!picked) return;
    this.device = picked;

    this.emitStatus('Building & running Flutter app…');
    await this.spawnFlutter(settings);

    if (settings.openStreamWindow) {
      this.emitLine('[extension] waiting for Flutter to start before launching the streaming window\n', 'console');
      await this.waitForFlutterStarted();

      if (!settings.desktopAppPath) {
        throw new Error(
          'EmulatorDesktopApp binary not found. Run `npm run bootstrap` in the extension folder ' +
          'to publish it, or set `emulatorStreamRun.desktopAppPath` in Settings.'
        );
      }

      this.emitStatus('Launching streaming window…');
      this.spawnStream(settings);
    }

    this.emitStatus('Running');
  }

  private async discoverAndPickDevice(settings: ResolvedSettings): Promise<DeviceEntry | null> {
    let devices: DeviceEntry[];
    try {
      devices = await fetchDevices(settings.server);
    } catch (err) {
      throw new Error(
        `Could not fetch devices from ${settings.server}: ${(err as Error).message}. ` +
        `Is the gateway server running? (Prefer 127.0.0.1 over localhost.)`
      );
    }

    try {
      const picked = settings.device
        ? this.findExplicit(devices, settings.device)
        : await pickDevice(devices);
      // Pre-flight the "already-in-use" check for the pinned-device path
      // too — pickDevice already enforces this for interactive picks,
      // but if the user hard-coded a device in launch.json we still
      // want to bail *before* spending time on `flutter run`.
      if (picked.in_use) throw new DeviceInUseError(picked);
      this.emitLine(
        `[extension] selected device ${picked.device_id} (${picked.platform ?? '?'} · ${picked.name ?? picked.avd_name ?? '?'})\n`,
        'console'
      );
      return picked;
    } catch (err) {
      if (err instanceof UserCancelled) {
        this.emitLine('[extension] cancelled\n', 'console');
        await this.stop('cancelled');
        return null;
      }
      throw err;
    }
  }

  async stop(reason: string): Promise<void> {
    if (this.stopping || this.terminated) return;
    this.stopping = true;
    this.emitLine(`[extension] stopping (${reason})\n`, 'console');

    if (this.flutter && this.flutter.isRunning) {
      this.emitLine('[extension] asking Flutter to quit\n', 'console');
      this.flutter.requestQuit();
      const exited = await raceExit(this.flutter, 5000);
      if (!exited && this.flutter?.isRunning) {
        this.emitLine('[extension] Flutter still alive, sending SIGTERM\n', 'console');
        this.flutter.kill('SIGTERM');
        const exited2 = await raceExit(this.flutter, 2000);
        if (!exited2 && this.flutter?.isRunning) {
          this.emitLine('[extension] Flutter still alive, sending SIGKILL\n', 'console');
          this.flutter.kill('SIGKILL');
        }
      }
    }

    if (this.stream && this.stream.isRunning) {
      this.emitLine('[extension] closing streaming window\n', 'console');
      this.stream.kill('SIGTERM');
      const exited = await raceExit(this.stream, 3000);
      if (!exited && this.stream?.isRunning) this.stream.kill('SIGKILL');
    }

    this.terminated = true;
    this.emit('terminated', { reason });
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async spawnFlutter(settings: ResolvedSettings): Promise<void> {
    if (!this.device) throw new Error('no device');
    const flutter = new FlutterRunner();
    this.flutter = flutter;
    flutter.on('output', (chunk: string, cat: 'stdout' | 'stderr') => this.emitLine(chunk, cat));
    flutter.on('debugPort', (uri: string) => this.emitLine(`[extension] Dart VM Service: ${uri}\n`, 'console'));
    flutter.on('exit', (code: number | null) => {
      if (this.terminated) return;
      this.emitLine(`[extension] Flutter exited (code=${code ?? 'null'})\n`, 'console');
      if (!this.stopping) void this.stop(`flutter_exit_${code ?? 'null'}`);
    });
    flutter.on('error', (err: Error) => this.emit('error', err));
    flutter.spawn({
      flutterPath: settings.flutterPath,
      flutterProject: settings.flutterProject,
      device: this.device,
      target: settings.target,
      flavor: settings.flavor,
      extraArgs: settings.flutterArgs,
    });
  }

  private waitForFlutterStarted(timeoutMs = 180_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const flutter = this.flutter;
      if (!flutter) return reject(new Error('flutter not spawned'));
      const timeout = setTimeout(() => {
        flutter.off('started', onStarted);
        flutter.off('exit', onExit);
        reject(new Error(`Flutter did not report app start within ${(timeoutMs / 1000).toFixed(0)}s`));
      }, timeoutMs);
      const onStarted = () => {
        clearTimeout(timeout);
        flutter.off('exit', onExit);
        resolve();
      };
      const onExit = (code: number | null) => {
        clearTimeout(timeout);
        flutter.off('started', onStarted);
        reject(new Error(`Flutter exited before app started (code=${code ?? 'null'})`));
      };
      flutter.once('started', onStarted);
      flutter.once('exit', onExit);
    });
  }

  private spawnStream(settings: ResolvedSettings): void {
    if (!this.device) throw new Error('no device');
    if (!settings.desktopAppPath) throw new Error('desktop app path unresolved');
    const stream = new StreamProcess();
    this.stream = stream;
    stream.on('output', (chunk: string, cat: 'stdout' | 'stderr') => this.emitLine(chunk, cat));
    stream.on('exit', (code: number | null) => {
      if (this.terminated) return;
      this.emitLine(`[extension] streaming window exited (code=${code ?? 'null'})\n`, 'console');
      // If the user closed only the streaming window but Flutter is still
      // running, leave Flutter alone. Otherwise unwind.
      if (!this.flutter || !this.flutter.isRunning) {
        if (!this.stopping) void this.stop(`stream_exit_${code ?? 'null'}`);
      }
    });
    stream.on('error', (err: Error) => this.emit('error', err));
    stream.spawn({
      desktopAppPath: settings.desktopAppPath,
      server: settings.server,
      deviceId: this.device.device_id,
    });
  }

  private findExplicit(devices: DeviceEntry[], id: string): DeviceEntry {
    const hit = devices.find((d) => d.device_id === id);
    if (!hit) {
      throw new Error(
        `Device "${id}" was not returned by the server. ` +
        `Available: ${devices.map((d) => d.device_id).join(', ') || '(none)'}`
      );
    }
    return hit;
  }

  private emitLine(line: string, category: 'stdout' | 'stderr' | 'console'): void {
    this.emit('output', line, category);
  }

  private emitStatus(msg: string): void {
    this.emit('status', msg);
    this.emitLine(`[extension] ${msg}\n`, 'console');
  }
}

function raceExit(proc: FlutterRunner | StreamProcess, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}
