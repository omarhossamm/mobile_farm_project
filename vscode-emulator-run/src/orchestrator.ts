import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { ServerClient, type DeviceEntry, type ProjectFlavor, type RunHandle } from './serverClient';
import { pickDevice, UserCancelled, DeviceInUseError } from './devicePicker';
import { pickProjectAndFlavor, pickFlavorFromList } from './projectPicker';
import { StreamProcess } from './streamProcess';
import { buildInfoForResolvedSource, type ResolvedSettings } from './settings';
import { formatBuildInfoLine, formatDiagnosticsReport, isStale, stalenessReason } from './desktopAppFreshness';
import { REBUILD_COMMAND } from './rebuildCommand';
import { DesktopAppInstaller, InstallerError, type ProgressReporter, type ResolvedSource } from './desktopAppInstaller';

/**
 * Concrete "what to run" record produced by {@link Orchestrator.resolveRemoteProject}.
 * Exactly one of `projectId` / `projectPath` is set; both feed into
 * `runFlutter` on the server.
 */
interface ResolvedRun {
  projectId?: string;
  projectPath?: string;
  flutterPath?: string;
  displayName: string;
  flavor: ProjectFlavor | null;
}

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

/**
 * Everything the orchestrator needs to resolve the desktop app binary
 * (either from the shipped bundle, the on-disk cache, or by
 * downloading). Kept as its own type so callers can pass it in without
 * needing the full `vscode.ExtensionContext`.
 */
export interface DesktopAppEnvironment {
  extensionRoot: string;
  cacheRoot: string;
  installer: DesktopAppInstaller;
}

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
  private desktopEnv: DesktopAppEnvironment | undefined;
  private resolvedDesktopApp: ResolvedSource | null = null;

  constructor(workspaceKey: string, lastChoiceStore: LastChoiceStore, desktopEnv?: DesktopAppEnvironment) {
    super();
    this.workspaceKey = workspaceKey;
    this.lastChoiceStore = lastChoiceStore;
    this.desktopEnv = desktopEnv;
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
    //   Two branches:
    //     a. Ad-hoc projectPath (setting or launch.json) — skip the
    //        registered-project list entirely; the server discovers
    //        flavors for that path via `list_flavors`.
    //     b. Registered project — the classic flow: `list_projects`
    //        → Quick Pick over projects → Quick Pick over flavors.
    const resolved = await this.resolveRemoteProject(client, settings);
    if (!resolved) return;

    // ── 3. Reserve device on this WS ──────────────────────────────────
    this.emitStatus(`Reserving device ${device.device_id}…`);
    const sessionId = await client.createSession(device.device_id);
    this.emitLine(`[extension] session created: ${sessionId}\n`, 'console');

    // ── 4. Run flutter on the remote host ─────────────────────────────
    this.emitStatus(`Running ${resolved.displayName}${resolved.flavor ? ` (${resolved.flavor.name})` : ''} on remote…`);
    this.runHandle = await client.runFlutter({
      projectId: resolved.projectId,
      projectPath: resolved.projectPath,
      flutterPath: resolved.flutterPath,
      flavorName: resolved.flavor?.name,
      deviceId: device.device_id,
      extraArgs: settings.flutterArgs,
    });
    this.emitLine(
      `[extension] remote runId=${this.runHandle.runId} path=${this.runHandle.projectPath || this.runHandle.projectId}\n`,
      'console'
    );

    // ── 5. Wait for the app to actually start on the device ──────────
    if (settings.openStreamWindow) {
      this.emitStatus('Waiting for Flutter to start on device…');
      await this.waitForAppReady(180_000);

      // Ensure a runnable desktop-app binary exists on this machine.
      // This is the first (and only) time we ever touch the network
      // in the F5 path: on a fresh install we'll download+extract
      // the pinned archive; on subsequent runs we hit the local cache
      // in a few milliseconds.
      const resolvedApp = await this.ensureDesktopApp(settings);
      const info = buildInfoForResolvedSource(resolvedApp.path, resolvedApp.kind, settings.desktopApp);
      this.reportDesktopAppFreshness(info, resolvedApp);

      this.emitStatus('Opening stream window…');
      this.spawnStream(settings, sessionId, resolvedApp.path);
    }

    this.emitStatus('Running');
  }

  /**
   * Make a runnable EmulatorDesktopApp available on this host — from
   * user override, shipped bundle, cache, or by downloading. Wraps the
   * download in `vscode.window.withProgress` so the user sees a
   * cancellable spinner during first-run installs (usually seconds on
   * broadband; the progress bar keeps them from thinking the extension
   * hung).
   */
  private async ensureDesktopApp(settings: ResolvedSettings): Promise<ResolvedSource> {
    if (this.resolvedDesktopApp) return this.resolvedDesktopApp;

    if (!this.desktopEnv) {
      // Old callers (e.g. tests) that constructed Orchestrator without
      // an installer environment fall back to the sync path: any
      // resolution the preliminary settings already made is used
      // as-is; nothing downloads.
      if (!settings.desktopApp.path) {
        this.emitLine(`[extension] ${formatDiagnosticsReport(settings.desktopApp)}\n`, 'stderr');
        throw new Error(stalenessReason(settings.desktopApp) ||
          'Desktop app is missing and no installer was configured for this Orchestrator instance.');
      }
      this.resolvedDesktopApp = { kind: settings.desktopApp.origin === 'user-setting' ? 'user-setting' : 'bundled', path: settings.desktopApp.path } as ResolvedSource;
      return this.resolvedDesktopApp;
    }

    try {
      const resolved = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Emulator Stream: preparing streaming viewer',
          cancellable: true,
        },
        async (progress, token) => {
          const reporter: ProgressReporter = ({ phase, bytes, totalBytes, message }) => {
            if (phase === 'downloading' && totalBytes) {
              const pct = totalBytes > 0 ? Math.round(((bytes ?? 0) / totalBytes) * 100) : 0;
              progress.report({ message: `${pct}% (${humanBytes(bytes ?? 0)} / ${humanBytes(totalBytes)})` });
            } else if (message) {
              progress.report({ message });
            }
          };
          return this.desktopEnv!.installer.ensure({
            extensionRoot: this.desktopEnv!.extensionRoot,
            cacheRoot: this.desktopEnv!.cacheRoot,
            rid: settings.desktopAppRid || undefined,
            userPath: settings.desktopApp.origin === 'user-setting' ? settings.desktopApp.path : undefined,
            progress: reporter,
            cancel: token,
            offline: true,
          });
        }
      );
      this.resolvedDesktopApp = resolved;
      return resolved;
    } catch (err) {
      // Give the debug console the full diagnostic dump before we
      // rethrow — the notification bubble the user sees is
      // necessarily short, but the console can carry everything.
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof InstallerError ? err.code : 'unknown';
      this.emitLine(`[extension] desktop-app install failed (code=${code}): ${message}\n`, 'stderr');
      this.emitLine(`[extension] ${formatDiagnosticsReport(settings.desktopApp)}\n`, 'stderr');
      throw new Error(`Cannot launch streaming viewer: ${message}`);
    }
  }

  /**
   * Info-line every run so users can eyeball the bundle version; warn
   * notification only when the binary is genuinely stale.
   *
   * With the download-on-first-run model, the realistic stale states
   * are:
   *   • dev mode: bootstrap.js built an outdated binary → Rebuild
   *   • cached/downloaded: some corruption of BUILD_INFO.json in the
   *     archive → advise a redownload via the doctor command
   *
   * The `resolved` argument tells us WHERE the binary came from so
   * we can pick the right remediation.
   */
  private reportDesktopAppFreshness(info: import('./desktopAppFreshness').DesktopAppInfo, resolved: ResolvedSource): void {
    const originLabel = resolved.kind === 'downloaded'
      ? `downloaded (v${'version' in resolved ? resolved.version : '?'})`
      : resolved.kind === 'cached'
        ? `cached (v${'version' in resolved ? resolved.version : '?'})`
        : resolved.kind;
    this.emitLine(`[extension] desktop app: ${info.path} [${originLabel}]\n`, 'console');
    this.emitLine(`[extension] desktop app info: ${formatBuildInfoLine(info)}\n`, 'console');
    if (!isStale(info)) return;
    const reason = stalenessReason(info);
    this.emitLine(`[extension] ⚠ ${reason}\n`, 'stderr');
    const actions = resolved.kind === 'bundled'
      ? ['Rebuild Desktop App (dev mode)', 'Dismiss']
      : ['Run Doctor', 'Dismiss'];
    void vscode.window
      .showWarningMessage(`Emulator Stream: ${reason}`, ...actions)
      .then((choice) => {
        if (choice === 'Rebuild Desktop App (dev mode)') {
          void vscode.commands.executeCommand(REBUILD_COMMAND);
        } else if (choice === 'Run Doctor') {
          void vscode.commands.executeCommand('emulatorStreamRun.doctor');
        }
      });
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
   * Decide what to run based on user configuration, in this order:
   *
   *   1. **Ad-hoc projectPath** — user supplied a filesystem path on
   *      the remote host (either via `emulatorStreamRun.projectPath`
   *      or `launch.json`'s `projectPath`). We ask the server to
   *      discover flavors for that path (`list_flavors`) and prompt a
   *      flavor Quick Pick — no project picker needed.
   *   2. **Registered projectId** — user pinned an id from the
   *      server's flutter-projects.json. We fetch the project list
   *      and look it up.
   *   3. **Fully interactive** — no pins. Fetch the project list and
   *      prompt project + flavor Quick Picks.
   *
   * Returns null when the user cancelled a picker (the orchestrator
   * has already emitted a cancelled message and shut down).
   */
  private async resolveRemoteProject(
    client: ServerClient,
    settings: ResolvedSettings
  ): Promise<ResolvedRun | null> {
    if (settings.projectId && settings.projectPath) {
      this.emitLine(
        '[extension] both projectId and projectPath were set — preferring projectPath\n',
        'stderr'
      );
    }

    // Branch a — ad-hoc projectPath (dynamic remote path).
    if (settings.projectPath) {
      this.emitStatus(`Discovering flavors for ${settings.projectPath}…`);
      const info = await client.fetchFlavors(settings.projectPath, settings.flutterPath);
      this.emitLine(
        `[extension] ${info.flavors.length} flavor(s) discovered at ${info.projectPath}\n`,
        'console'
      );
      try {
        const flavor = await this.pickFlavor(info.flavors, info.name, settings);
        return {
          projectPath: info.projectPath,
          flutterPath: settings.flutterPath,
          displayName: info.name,
          flavor,
        };
      } catch (err) {
        return this.handlePickerCancel(err);
      }
    }

    // Branch b — registered projectId (or fully interactive).
    this.emitStatus('Fetching remote projects…');
    const projects = await client.fetchProjects();

    if (settings.projectId) {
      const proj = projects.find((p) => p.id === settings.projectId);
      if (!proj) {
        throw new Error(
          `Project "${settings.projectId}" is not configured on the server. ` +
          `Known: ${projects.map((p) => p.id).join(', ') || '(none)'}. ` +
          `Alternatively set emulatorStreamRun.projectPath / launch.json "projectPath" ` +
          `to point at a Flutter folder on the remote directly.`
        );
      }
      try {
        const flavor = await this.pickFlavor(proj.flavors, proj.name, settings);
        return {
          projectId: proj.id,
          displayName: proj.name,
          flavor,
        };
      } catch (err) {
        return this.handlePickerCancel(err);
      }
    }

    // Branch c — full interactive pick.
    try {
      const lastProject = this.lastChoiceStore?.get<string>(`lastProject:${this.workspaceKey}`);
      const lastFlavor  = this.lastChoiceStore?.get<string>(`lastFlavor:${this.workspaceKey}`);
      const picked = await pickProjectAndFlavor(projects, { lastProject, lastFlavor });
      if (this.lastChoiceStore) {
        await this.lastChoiceStore.update(`lastProject:${this.workspaceKey}`, picked.project.id);
        await this.lastChoiceStore.update(`lastFlavor:${this.workspaceKey}`,  picked.flavor?.name ?? '');
      }
      return {
        projectId: picked.project.id,
        displayName: picked.project.name,
        flavor: picked.flavor,
      };
    } catch (err) {
      return this.handlePickerCancel(err);
    }
  }

  /**
   * Common flavor selector: honours `settings.flavor` pin, otherwise
   * falls back to the Quick Pick from projectPicker. Used by both the
   * ad-hoc projectPath path and the registered projectId path.
   */
  private async pickFlavor(
    flavors: ProjectFlavor[],
    projectDisplayName: string,
    settings: ResolvedSettings
  ): Promise<ProjectFlavor | null> {
    if (settings.flavor) {
      const hit = flavors.find((f) => f.name === settings.flavor);
      if (!hit) {
        throw new Error(
          `Flavor "${settings.flavor}" is not defined for ${projectDisplayName}. ` +
          `Known: ${flavors.map((f) => f.name).join(', ') || '(none)'}`
        );
      }
      return hit;
    }
    return pickFlavorFromList(flavors, projectDisplayName);
  }

  private handlePickerCancel(err: unknown): null {
    if (err instanceof UserCancelled) {
      this.emitLine('[extension] cancelled\n', 'console');
      void this.stop('cancelled');
      return null;
    }
    throw err;
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

  private spawnStream(settings: ResolvedSettings, sessionId: string, desktopAppPath: string): void {
    if (!this.device) throw new Error('no device');
    if (!desktopAppPath) throw new Error('desktop app path unresolved');
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
      desktopAppPath,
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

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
