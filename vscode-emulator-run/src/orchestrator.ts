import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { ServerClient, type DeviceEntry, type ProjectFlavor, type ProjectEntry, type RunHandle } from './serverClient';
import { pickDevice, UserCancelled, DeviceInUseError } from './devicePicker';
import { pickProjectAndFlavor } from './projectPicker';
import { StreamProcess } from './streamProcess';
import type { ResolvedSettings } from './settings';

/**
 * Thin-client orchestrator.
 *
 * The developer machine never runs `flutter run`, adb, xcodebuild or
 * touches devices. This class:
 *
 *   1. Opens ONE long-lived WebSocket to the remote gateway server.
 *   2. Fetches the device list, filters in-use devices, prompts a
 *      Quick Pick (unless a device is pinned in launch.json).
 *   3. Fetches the project list from the server and prompts a
 *      Quick Pick for project + flavor (unless pinned).
 *   4. `create_session` — reserves the device on this WS.
 *   5. `run_flutter` — server spawns `flutter run`; output/ready/exit
 *      events stream back on the same WS.
 *   6. Once the server emits `flutter_ready`, launches the local
 *      EmulatorDesktopApp with `--session-id <ours>` so it adopts
 *      the pre-created session instead of creating a duplicate.
 *
 * On stop:
 *   • `stop_flutter` — server sends 'q' → SIGTERM → SIGKILL.
 *   • SIGTERM the local desktop app process.
 *   • `destroy_session` + close the WS → server releases the device.
 */
export interface OrchestratorEvents {
  output: (line: string, category: 'stdout' | 'stderr' | 'console') => void;
  status: (message: string) => void;
  terminated: (info: { reason: string }) => void;
  error: (err: Error) => void;
}

type LastChoiceStore = vscode.Memento | undefined;

export class Orchestrator extends EventEmitter {
  private client: ServerClient | null = null;
  private stream: StreamProcess | null = null;
  private device: DeviceEntry | null = null;
  private runHandle: RunHandle | null = null;
  private stopping = false;
  private terminated = false;
  private appReady = false;
  private workspaceKey: string;
  private lastChoiceStore: LastChoiceStore;

  constructor(workspaceKey: string, lastChoiceStore: LastChoiceStore) {
    super();
    this.workspaceKey = workspaceKey;
    this.lastChoiceStore = lastChoiceStore;
  }

  async start(settings: ResolvedSettings): Promise<void> {
    this.emitStatus(`Connecting to ${settings.server}…`);
    const client = new ServerClient();
    this.client = client;

    // Wire the remote-flutter event stream to the debug console.
    client.on('flutter_output', (_rid: string, stream: 'stdout' | 'stderr', line: string) => {
      this.emitLine(line, stream);
    });
    client.on('flutter_ready', (_rid: string, uri: string | null) => {
      if (uri) this.emitLine(`[extension] Dart VM Service: ${uri}\n`, 'console');
      this.emitLine('[extension] Flutter app is running on the remote device\n', 'console');
      this.appReady = true;
    });
    client.on('flutter_exit', (_rid: string, code: number | null, signal: string | null) => {
      if (this.terminated) return;
      this.emitLine(`[extension] remote flutter exited (code=${code ?? 'null'} signal=${signal ?? 'null'})\n`, 'console');
      if (!this.stopping) void this.stop(`flutter_exit_${code ?? 'null'}`);
    });
    client.on('flutter_run_started', (_rid: string, cmd: string, cwd: string) => {
      this.emitLine(`[remote] $ ${cmd}\n`, 'stdout');
      this.emitLine(`[remote] cwd=${cwd}\n`, 'stdout');
    });
    client.on('error', (err: Error) => this.emit('error', err));
    client.on('closed', (code, reason) => {
      this.emitLine(`[extension] server connection closed (code=${code}${reason ? `, ${reason}` : ''})\n`, 'console');
      if (!this.stopping) void this.stop('server_closed');
    });

    await client.connect(settings.server);
    this.emitLine(`[extension] connected — server session ${client.serverSessionId}\n`, 'console');

    // ── 1. Device ─────────────────────────────────────────────────────
    this.emitStatus('Fetching devices…');
    const device = await this.discoverAndPickDevice(client, settings);
    if (!device) return;
    this.device = device;

    // ── 2. Project + flavor ───────────────────────────────────────────
    this.emitStatus('Fetching remote projects…');
    const projects = await client.fetchProjects();
    const { project, flavor } = await this.resolveProject(projects, settings);
    if (!project) return;

    // ── 3. Reserve device on this WS ──────────────────────────────────
    this.emitStatus(`Reserving device ${device.device_id}…`);
    const sessionId = await client.createSession(device.device_id);
    this.emitLine(`[extension] session created: ${sessionId}\n`, 'console');

    // ── 4. Run flutter on the remote host ─────────────────────────────
    this.emitStatus(`Running ${project.name}${flavor ? ` (${flavor.name})` : ''} on remote…`);
    this.runHandle = await client.runFlutter({
      projectId: project.id,
      flavorName: flavor?.name,
      deviceId: device.device_id,
      extraArgs: settings.flutterArgs,
    });
    this.emitLine(`[extension] remote runId=${this.runHandle.runId}\n`, 'console');

    // ── 5. Wait for the app to actually start on the device ──────────
    if (settings.openStreamWindow) {
      this.emitStatus('Waiting for Flutter to start on device…');
      await this.waitForAppReady(180_000);
      if (!settings.desktopAppPath) {
        throw new Error(
          'EmulatorDesktopApp binary not found. Run `npm run bootstrap` in the extension folder ' +
          'or set `emulatorStreamRun.desktopAppPath`.'
        );
      }
      this.emitStatus('Opening stream window…');
      this.spawnStream(settings, sessionId);
    }

    this.emitStatus('Running');
  }

  private async discoverAndPickDevice(client: ServerClient, settings: ResolvedSettings): Promise<DeviceEntry | null> {
    const devices = await client.fetchDevices();
    try {
      const picked = settings.device
        ? this.findExplicit(devices, settings.device)
        : await pickDevice(devices);
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

  /**
   * Resolve project + flavor from either the pinned launch.json entry
   * or the interactive Quick Pick. Pinned values take precedence; if
   * the pinned name doesn't match anything on the server, we surface a
   * clear error before doing any expensive work.
   */
  private async resolveProject(
    projects: ProjectEntry[],
    settings: ResolvedSettings
  ): Promise<{ project: ProjectEntry | null; flavor: ProjectFlavor | null }> {
    if (settings.projectId) {
      const proj = projects.find((p) => p.id === settings.projectId);
      if (!proj) {
        throw new Error(
          `Project "${settings.projectId}" is not configured on the server. ` +
          `Known: ${projects.map((p) => p.id).join(', ') || '(none)'}`
        );
      }
      const flavor = settings.flavor
        ? proj.flavors.find((f) => f.name === settings.flavor) ?? null
        : null;
      if (settings.flavor && !flavor) {
        throw new Error(
          `Flavor "${settings.flavor}" is not defined for project "${proj.id}". ` +
          `Known: ${proj.flavors.map((f) => f.name).join(', ') || '(none)'}`
        );
      }
      return { project: proj, flavor };
    }
    try {
      const lastProject = this.lastChoiceStore?.get<string>(`lastProject:${this.workspaceKey}`);
      const lastFlavor  = this.lastChoiceStore?.get<string>(`lastFlavor:${this.workspaceKey}`);
      const picked = await pickProjectAndFlavor(projects, { lastProject, lastFlavor });
      // Remember for next time.
      if (this.lastChoiceStore) {
        await this.lastChoiceStore.update(`lastProject:${this.workspaceKey}`, picked.project.id);
        await this.lastChoiceStore.update(`lastFlavor:${this.workspaceKey}`,  picked.flavor?.name ?? '');
      }
      return picked;
    } catch (err) {
      if (err instanceof UserCancelled) {
        this.emitLine('[extension] cancelled\n', 'console');
        await this.stop('cancelled');
        return { project: null, flavor: null };
      }
      throw err;
    }
  }

  private waitForAppReady(timeoutMs: number): Promise<void> {
    if (this.appReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.client?.off('flutter_ready', onReady);
        this.client?.off('flutter_exit', onExit);
        reject(new Error(`Remote Flutter did not report app-started within ${(timeoutMs / 1000).toFixed(0)}s`));
      }, timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        this.client?.off('flutter_exit', onExit);
        this.appReady = true;
        resolve();
      };
      const onExit = (_rid: string, code: number | null) => {
        clearTimeout(timer);
        this.client?.off('flutter_ready', onReady);
        reject(new Error(`Remote Flutter exited before app started (code=${code ?? 'null'})`));
      };
      this.client!.once('flutter_ready', onReady);
      this.client!.once('flutter_exit', onExit);
    });
  }

  async stop(reason: string): Promise<void> {
    if (this.stopping || this.terminated) return;
    this.stopping = true;
    this.emitLine(`[extension] stopping (${reason})\n`, 'console');

    // Ask the server to stop the flutter subprocess first (graceful 'q').
    if (this.client && this.runHandle) {
      this.emitLine('[extension] asking remote to stop Flutter\n', 'console');
      try { await this.client.stopFlutter(this.runHandle.runId); } catch { /* ignore */ }
    }

    if (this.stream && this.stream.isRunning) {
      this.emitLine('[extension] closing streaming window\n', 'console');
      this.stream.kill('SIGTERM');
      const exited = await raceExit(this.stream, 3000);
      if (!exited && this.stream?.isRunning) this.stream.kill('SIGKILL');
    }

    if (this.client) {
      try { await this.client.destroySession(); } catch { /* ignore */ }
      this.client.disconnect();
    }

    this.terminated = true;
    this.emit('terminated', { reason });
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private spawnStream(settings: ResolvedSettings, sessionId: string): void {
    if (!this.device) throw new Error('no device');
    if (!settings.desktopAppPath) throw new Error('desktop app path unresolved');
    const stream = new StreamProcess();
    this.stream = stream;
    stream.on('output', (chunk: string, cat: 'stdout' | 'stderr') => this.emitLine(chunk, cat));
    stream.on('exit', (code: number | null) => {
      if (this.terminated) return;
      this.emitLine(`[extension] streaming window exited (code=${code ?? 'null'})\n`, 'console');
      // If the user only closed the streaming window, tear the rest down too.
      if (!this.stopping) void this.stop(`stream_exit_${code ?? 'null'}`);
    });
    stream.on('error', (err: Error) => this.emit('error', err));
    stream.spawn({
      desktopAppPath: settings.desktopAppPath,
      server: settings.server,
      deviceId: this.device.device_id,
      sessionId,
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

function raceExit(proc: StreamProcess, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}
