import { EventEmitter } from 'events';
import WebSocket from 'ws';

/**
 * Long-lived WebSocket client for the emulator gateway.
 *
 * Owns the full extension ↔ server conversation:
 *   • `get_devices`     — list devices with in_use annotations.
 *   • `list_projects`   — list Flutter projects configured on the server.
 *   • `create_session`  — reserve a device for this WS.
 *   • `run_flutter`     — start `flutter run` remotely; server emits
 *                         `flutter_output`, `flutter_ready`, `flutter_exit` events
 *                         which we re-emit as EventEmitter events.
 *   • `stop_flutter`    — graceful stop via 'q' + escalate.
 *   • `flutter_hotkey`  — deliver a single hotkey ('r' hot-reload etc.)
 *
 * The developer's machine never touches Flutter, adb, xcodebuild, or
 * the emulator directly — everything is issued as JSON over this
 * socket. See websocket_nodejs/adb-emulator-server/flutter/*.js for
 * the server-side counterpart.
 */

export interface DeviceEntry {
  device_id: string;
  platform?: string;
  status?: string;
  name?: string;
  avd_name?: string;
  in_use?: boolean;
  owner_session_id?: string | null;
}

export interface ProjectFlavor {
  name: string;
  target?: string | null;
  flavor?: string | null;
  args?: string[];
}

export interface ProjectEntry {
  id: string;
  name: string;
  flavors: ProjectFlavor[];
}

export interface RunFlutterOptions {
  /** Registered project id (from server's flutter-projects.json). Exclusive with `projectPath`. */
  projectId?: string;
  /**
   * Ad-hoc filesystem path on the REMOTE machine. When set, the
   * server treats it like a project without needing it in
   * flutter-projects.json. Exclusive with `projectId`.
   */
  projectPath?: string;
  /** Override the `flutter` binary for ad-hoc projectPath runs. Falls back to `flutter` on PATH. */
  flutterPath?: string;
  flavorName?: string;
  deviceId: string;
  extraArgs?: string[];
}

export interface RunHandle {
  runId: string;
  projectId: string;
  projectPath: string;
  deviceId: string;
  flavor: string | null;
}

/**
 * Result of `list_flavors` for an ad-hoc `projectPath`. Mirrors the
 * flavor entries embedded in `list_projects` — the server does the
 * same auto-discovery either way (launch.json + `lib/main_*.dart`).
 */
export interface AdHocProjectInfo {
  projectPath: string;
  name: string;
  flavors: ProjectFlavor[];
}

/**
 * Emitted events (typed for readability):
 *   'flutter_output' → (runId, stream: 'stdout'|'stderr', line)
 *   'flutter_ready'  → (runId, vmServiceUri?)
 *   'flutter_exit'   → (runId, code, signal)
 *   'closed'         → (code, reason)
 *   'error'          → (err)
 */
export class ServerClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private nextRequestId = 1;
  private pending = new Map<string, { resolve(v: any): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  private closed = false;

  /** `sessionId` assigned by the server on the 'connected' message. */
  get serverSessionId(): string | null { return this.sessionId; }

  async connect(server: string, timeoutMs = 8000): Promise<void> {
    const normalized = server.replace(/^(ws{1,2}s?):\/\/localhost([:/])/i, '$1://127.0.0.1$2');
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(normalized);
      this.ws = ws;
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch { /* ignore */ }
        reject(new Error(`Timed out connecting to ${normalized} after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.once('open', () => { /* wait for `connected` msg to resolve */ });
      ws.on('message', (raw) => this.onMessage(raw));
      ws.once('error', (err) => {
        clearTimeout(timer);
        if (!this.closed) reject(err);
      });
      ws.once('close', (code, reason) => {
        clearTimeout(timer);
        this.closed = true;
        this.emit('closed', code, reason?.toString?.() ?? '');
        // Reject any pending requests so callers unblock.
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Server closed connection (code=${code})`));
        }
        this.pending.clear();
      });

      // Resolve the outer promise once the server sends its 'connected' message.
      const onConnected = (parsed: any) => {
        if (parsed?.type === 'connected' && parsed?.success !== false) {
          clearTimeout(timer);
          this.sessionId = parsed?.data?.session_id ?? null;
          this.off('_raw', onConnected);
          resolve();
        }
      };
      this.on('_raw', onConnected);
    });
  }

  disconnect(): void {
    this.closed = true;
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  // ── High-level API ────────────────────────────────────────────────────

  async fetchDevices(): Promise<DeviceEntry[]> {
    const res = await this.request('get_devices', {});
    return normalizeDevices(res?.data);
  }

  async fetchProjects(): Promise<ProjectEntry[]> {
    const res = await this.request('list_projects', {});
    const list = res?.data?.projects;
    return Array.isArray(list) ? list : [];
  }

  /**
   * Ask the server "given this raw path on your filesystem, what
   * flavors would you discover for it?" Used by the extension when
   * the user pins `emulatorStreamRun.projectPath` — we skip the
   * registered-project picker and drive the flavor Quick Pick from
   * the response instead.
   */
  async fetchFlavors(projectPath: string, flutterPath?: string): Promise<AdHocProjectInfo> {
    const res = await this.request('list_flavors', {
      projectPath,
      flutterPath: flutterPath ?? null,
    });
    const data = res?.data ?? {};
    return {
      projectPath: String(data.projectPath ?? projectPath),
      name: String(data.name ?? projectPath),
      flavors: Array.isArray(data.flavors) ? data.flavors : [],
    };
  }

  async createSession(deviceId: string): Promise<string> {
    const res = await this.request('create_session', { device: deviceId }, 60_000);
    const sid = res?.data?.session_id ?? this.sessionId;
    if (!sid) throw new Error('Server did not return a session id');
    this.sessionId = sid;
    return sid;
  }

  async destroySession(): Promise<void> {
    if (!this.sessionId) return;
    try { await this.request('destroy_session', {}, 10_000); }
    catch { /* server may have already released it — closing the socket does the rest */ }
  }

  async runFlutter(opts: RunFlutterOptions): Promise<RunHandle> {
    if (!opts.projectId && !opts.projectPath) {
      throw new Error('runFlutter needs one of projectId or projectPath');
    }
    if (opts.projectId && opts.projectPath) {
      throw new Error('runFlutter accepts projectId OR projectPath, not both');
    }
    const res = await this.request('run_flutter', {
      projectId: opts.projectId ?? null,
      projectPath: opts.projectPath ?? null,
      flutterPath: opts.flutterPath ?? null,
      flavorName: opts.flavorName ?? null,
      deviceId: opts.deviceId,
      extraArgs: opts.extraArgs ?? [],
    });
    return {
      runId: String(res?.data?.runId ?? ''),
      projectId: String(res?.data?.projectId ?? opts.projectId ?? ''),
      projectPath: String(res?.data?.projectPath ?? opts.projectPath ?? ''),
      deviceId: String(res?.data?.deviceId ?? opts.deviceId),
      flavor: res?.data?.flavor ?? null,
    };
  }

  async stopFlutter(runId: string): Promise<void> {
    try { await this.request('stop_flutter', { runId }, 15_000); }
    catch { /* the flutter_exit event handles the actual completion */ }
  }

  async hotkey(runId: string, key: string): Promise<void> {
    await this.request('flutter_hotkey', { runId, key });
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * Send a JSON request and await the matching response by requestId.
   * Response is either { success: true, ... } or { success: false, error }.
   */
  private request(type: string, payload: any, timeoutMs = 15_000): Promise<any> {
    if (!this.ws || this.closed) return Promise.reject(new Error('Not connected to server'));
    const requestId = `req-${this.nextRequestId++}`;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Request "${type}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.ws!.send(JSON.stringify({ type, ...payload, requestId }));
      } catch (err) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onMessage(raw: WebSocket.RawData): void {
    let parsed: any;
    try { parsed = JSON.parse(raw.toString()); }
    catch { return; }

    // Correlated response?
    if (parsed?.requestId && this.pending.has(parsed.requestId)) {
      const pending = this.pending.get(parsed.requestId)!;
      this.pending.delete(parsed.requestId);
      clearTimeout(pending.timer);
      if (parsed.success === false) pending.reject(new Error(parsed.error || `Server error on ${parsed.type}`));
      else pending.resolve(parsed);
      return;
    }

    // Unsolicited events we care about.
    switch (parsed?.type) {
      case 'flutter_output':
        this.emit('flutter_output', parsed.runId, parsed.stream, parsed.line);
        break;
      case 'flutter_ready':
        this.emit('flutter_ready', parsed.runId, parsed.vmServiceUri ?? null);
        break;
      case 'flutter_exit':
        this.emit('flutter_exit', parsed.runId, parsed.code ?? null, parsed.signal ?? null);
        break;
      case 'flutter_run_started':
        this.emit('flutter_run_started', parsed.runId, parsed.cmd, parsed.cwd);
        break;
    }

    // Also expose everything raw for `connect()` handshake matcher.
    this.emit('_raw', parsed);
  }
}

function normalizeDevices(data: any): DeviceEntry[] {
  const list = data?.devices ?? [];
  if (!Array.isArray(list)) return [];
  return list.map((d: any) => ({
    device_id: String(d.device_id ?? d.id ?? ''),
    platform: d.platform,
    status: d.status,
    name: d.name,
    avd_name: d.avd_name,
    in_use: d.in_use === true,
    owner_session_id: d.owner_session_id ?? null,
  })).filter((d) => d.device_id.length > 0);
}

/**
 * One-shot device fetch (opens a socket, fetches, closes). Kept for
 * backwards compatibility with the "List devices" command.
 */
export async function fetchDevices(server: string, timeoutMs = 5_000): Promise<DeviceEntry[]> {
  const client = new ServerClient();
  try {
    await client.connect(server, timeoutMs);
    return await client.fetchDevices();
  } finally {
    client.disconnect();
  }
}
