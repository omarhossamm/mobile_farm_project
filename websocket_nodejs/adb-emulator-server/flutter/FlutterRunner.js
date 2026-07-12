/**
 * FlutterRunner
 *
 * Server-side counterpart of what used to live in the extension: spawn
 * `flutter run` for a project, forward its output to the requesting WS
 * client, detect the app-started marker + VM Service URI, and expose a
 * clean stop / hotkey channel.
 *
 * Wire protocol (session-scoped):
 *
 *   Client → Server:
 *     { type: "run_flutter", projectId, flavorName?, deviceId,
 *       extraArgs?: string[], requestId? }
 *     { type: "stop_flutter", runId, requestId? }
 *     { type: "flutter_hotkey", runId, key, requestId? }
 *         // key is one of Flutter's own hotkeys: 'r' hot-reload,
 *         // 'R' hot-restart, 'p' toggle debug paint, 'q' quit, etc.
 *
 *   Server → Client (events):
 *     { type: "flutter_run_started", runId, projectId, deviceId, cmd, cwd }
 *     { type: "flutter_output", runId, stream: "stdout"|"stderr", line }
 *     { type: "flutter_ready", runId, vmServiceUri? }
 *     { type: "flutter_exit", runId, code, signal }
 *
 * Session tie-in: one runner per WS session. If the session closes,
 * we auto-kill the flutter subprocess so a crashed extension never
 * leaves a dangling `flutter run` on the remote.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const projectRegistry = require('./projectRegistry');
const sessionWorkspace = require('./sessionWorkspace');

const logger = {
  info:  (m, d = {}) => console.log (`[FLUTTER][INFO]  ${new Date().toISOString()} - ${m}`, Object.keys(d).length ? d : ''),
  warn:  (m, d = {}) => console.warn(`[FLUTTER][WARN]  ${new Date().toISOString()} - ${m}`, Object.keys(d).length ? d : ''),
  error: (m, d = {}) => console.error(`[FLUTTER][ERROR] ${new Date().toISOString()} - ${m}`, Object.keys(d).length ? d : ''),
};

const STARTED_MARKERS = [
  /Application (.+) started\./i,
  /Syncing files to device .+\.\.\. \d+ms/i,
  /is available at:/i,
];
const VM_SERVICE_MARKERS = [
  /Dart VM Service.*at\s+(https?:\/\/\S+)/i,
  /Observatory (?:URL|listening|debug service).*(https?:\/\/\S+)/i,
];

/**
 * One flutter subprocess. Owns the child + the parsing state; the
 * FlutterRunnerService coordinates them across sessions.
 *
 * `project.path` is the *effective* cwd — for an isolated workspace
 * that's the snapshot, not the origin. `originPath` is kept
 * alongside purely for observability (logs + response) so the
 * client can trace back to the folder they asked for.
 */
class FlutterRun {
  constructor({ runId, session, project, originPath, isolated, flavor, deviceId, extraArgs = [] }) {
    this.runId = runId;
    this.session = session;
    this.project = project;
    this.originPath = originPath ?? project.path;
    this.isolated = !!isolated;
    this.flavor = flavor;
    this.deviceId = deviceId;
    this.extraArgs = extraArgs;
    this.child = null;
    this.startedFired = false;
    this.vmServiceUri = null;
  }

  start() {
    const args = ['run', '-d', this.deviceId];
    if (this.flavor?.target)  args.push('--target', this.flavor.target);
    if (this.flavor?.flavor)  args.push('--flavor', this.flavor.flavor);
    if (this.flavor?.args?.length) args.push(...this.flavor.args);
    if (this.extraArgs?.length)     args.push(...this.extraArgs);

    const cmd = this.project.flutterPath || 'flutter';
    const cwd = this.project.path;
    logger.info('spawn flutter', {
      runId: this.runId, sessionId: this.session.id, cmd, args, cwd,
      origin: this.originPath, isolated: this.isolated,
    });

    // Surface the isolation state to the client on the same output
    // channel it reads flutter's stdout from — no protocol change
    // required, just an extra informational line. Clients that
    // don't render it lose nothing.
    if (this.isolated) {
      this.session.send({
        type: 'flutter_output',
        runId: this.runId,
        stream: 'stdout',
        line: `[server] isolated workspace: ${cwd}\n[server] origin: ${this.originPath}\n`,
      });
    }

    this.child = spawn(cmd, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.session.send({
      type: 'flutter_run_started',
      runId: this.runId,
      projectId: this.project.id,
      deviceId: this.deviceId,
      cmd: `${cmd} ${args.join(' ')}`,
      cwd,
      originPath: this.originPath,
      isolated: this.isolated,
    });

    this.child.stdout.on('data', (b) => this._onChunk(b, 'stdout'));
    this.child.stderr.on('data', (b) => this._onChunk(b, 'stderr'));

    this.child.on('exit', (code, signal) => {
      logger.info('flutter exit', { runId: this.runId, code, signal });
      this.session.send({
        type: 'flutter_exit',
        runId: this.runId,
        code: code === null ? null : code,
        signal: signal || null,
      });
      this.child = null;
    });

    this.child.on('error', (err) => {
      logger.error('flutter spawn error', { runId: this.runId, error: err.message });
      this.session.send({
        type: 'flutter_output',
        runId: this.runId,
        stream: 'stderr',
        line: `[flutter-runner] spawn failed: ${err.message}\n`,
      });
    });
  }

  _onChunk(buf, stream) {
    const text = buf.toString('utf8');
    // Line-split so client renders exactly one output event per line —
    // avoids partial-lines when flutter's output is chunked mid-line.
    for (const rawLine of text.split(/\r?\n/)) {
      if (rawLine.length === 0) continue;
      this.session.send({
        type: 'flutter_output',
        runId: this.runId,
        stream,
        line: rawLine + '\n',
      });
    }

    if (!this.startedFired) {
      for (const rx of STARTED_MARKERS) {
        if (rx.test(text)) {
          this.startedFired = true;
          this.session.send({
            type: 'flutter_ready',
            runId: this.runId,
            vmServiceUri: this.vmServiceUri,
          });
          break;
        }
      }
    }
    for (const rx of VM_SERVICE_MARKERS) {
      const m = text.match(rx);
      if (m?.[1]) {
        this.vmServiceUri = m[1];
        // If we hadn't yet declared "ready" and got a VM service URI,
        // fire it now — that's the strongest possible signal Flutter is up.
        if (!this.startedFired) {
          this.startedFired = true;
          this.session.send({ type: 'flutter_ready', runId: this.runId, vmServiceUri: this.vmServiceUri });
        }
        break;
      }
    }
  }

  hotkey(key) {
    if (!this.child || this.child.exitCode !== null) return false;
    try {
      this.child.stdin.write(key.endsWith('\n') ? key : key + '\n');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Graceful stop:
   *   1. Send 'q' on stdin (flutter's own quit command).
   *   2. Wait `gracePeriodMs` for exit.
   *   3. SIGTERM → wait 2s → SIGKILL.
   */
  async stop({ gracePeriodMs = 5000 } = {}) {
    if (!this.child) return;
    this.hotkey('q');
    if (!(await this._waitExit(gracePeriodMs))) {
      logger.warn('flutter did not quit gracefully — SIGTERM', { runId: this.runId });
      try { this.child?.kill('SIGTERM'); } catch { /* ignore */ }
      if (!(await this._waitExit(2000))) {
        logger.warn('flutter still alive — SIGKILL', { runId: this.runId });
        try { this.child?.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
  }

  _waitExit(ms) {
    if (!this.child) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
  }
}

/**
 * Global registry keyed by runId. One FlutterRun can only belong to
 * one session — enforced by looking up via `session.id` on stop.
 */
const runsByRunId = new Map();
const runIdsBySessionId = new Map();

function _newRunId() {
  return crypto.randomBytes(6).toString('hex');
}

function _addRun(run) {
  runsByRunId.set(run.runId, run);
  const set = runIdsBySessionId.get(run.session.id) ?? new Set();
  set.add(run.runId);
  runIdsBySessionId.set(run.session.id, set);
}

function _removeRun(runId, sessionId) {
  runsByRunId.delete(runId);
  const set = runIdsBySessionId.get(sessionId);
  if (set) {
    set.delete(runId);
    if (set.size === 0) runIdsBySessionId.delete(sessionId);
  }
}

/**
 * Turn a per-project `workspace` override (from
 * flutter-projects.json) into the opts shape sessionWorkspace.prepare
 * expects. Keeps only recognised fields so a typo can't accidentally
 * silence our defaults.
 */
function _resolveWorkspaceOpts(perProject) {
  if (!perProject || typeof perProject !== 'object') return {};
  const opts = {};
  if (perProject.mode === 'copy' || perProject.mode === 'shared') opts.mode = perProject.mode;
  if (Array.isArray(perProject.excludeDirs))  opts.excludeDirs  = perProject.excludeDirs;
  if (Array.isArray(perProject.excludeFiles)) opts.excludeFiles = perProject.excludeFiles;
  return opts;
}

/**
 * Resolve a project from either its registry id OR a raw filesystem
 * path (ad-hoc — supplied dynamically by the client). Exactly one of
 * the two must be provided. Returns `{ project }` on success or
 * `{ error }` with a human-readable reason on failure.
 */
function _resolveProject({ projectId, projectPath, flutterPath }) {
  if (projectId && projectPath) {
    return { error: 'Pass either projectId or projectPath, not both' };
  }
  if (projectId) {
    const project = projectRegistry.getProject(projectId);
    if (!project) {
      return {
        error: `Unknown project "${projectId}". Configure it in flutter-projects.json on the server, ` +
               `or pass "projectPath" directly to run any Flutter checkout without editing the config.`,
      };
    }
    if (!fs.existsSync(path.join(project.path, 'pubspec.yaml'))) {
      return { error: `Project "${projectId}" points at ${project.path} but no pubspec.yaml is there.` };
    }
    return { project };
  }
  if (projectPath) {
    const built = projectRegistry.buildAdHocProject(projectPath, flutterPath);
    if (!built.ok) return { error: built.error };
    return { project: built.project };
  }
  return { error: 'One of projectId or projectPath is required' };
}

/**
 * WS handler exports — plug straight into server.js messageHandlers.
 */
module.exports = {
  list_projects: async (session, payload) => {
    const projects = projectRegistry.listProjects();
    session.sendSuccess('projects_list', { projects }, payload.requestId);
  },

  /**
   * Discover flavors for a caller-supplied projectPath. Used by the
   * extension when the user pins `emulatorStreamRun.projectPath`
   * (or the `projectPath` launch.json field) instead of picking from
   * flutter-projects.json — we still need a flavor list to drive the
   * Quick Pick.
   */
  list_flavors: async (session, payload) => {
    const { projectPath, flutterPath = null } = payload || {};
    const built = projectRegistry.buildAdHocProject(projectPath, flutterPath);
    if (!built.ok) return session.sendError('list_flavors', built.error, payload?.requestId);
    session.sendSuccess(
      'flavors_list',
      {
        projectPath: built.project.path,
        name: built.project.name,
        flavors: built.project.flavors.map(projectRegistry.publicFlavor),
      },
      payload?.requestId
    );
  },

  run_flutter: async (session, payload) => {
    const {
      projectId = null,
      projectPath = null,
      flutterPath = null,
      flavorName = null,
      deviceId,
      extraArgs = [],
    } = payload || {};
    if (!deviceId) return session.sendError('run_flutter', 'deviceId is required', payload?.requestId);

    const resolved = _resolveProject({ projectId, projectPath, flutterPath });
    if (resolved.error) return session.sendError('run_flutter', resolved.error, payload?.requestId);
    const project = resolved.project;

    // Flavor lookup: registered projects search their configured
    // flavor list; ad-hoc projects use whatever the discovery
    // heuristic found (same list, resolved during buildAdHocProject).
    const flavor = flavorName
      ? project.flavors.find((f) => f.name === flavorName) ?? null
      : null;
    if (flavorName && !flavor) {
      return session.sendError(
        'run_flutter',
        `Flavor "${flavorName}" not found for project at ${project.path}. ` +
        `Known: ${project.flavors.map((f) => f.name).join(', ') || '(none)'}`,
        payload?.requestId
      );
    }

    // Isolated workspace — this is the heart of the "concurrent
    // developers" fix. `project.workspace` (from flutter-projects.json
    // per-project override) wins over the global default. `flutter run`
    // then executes with cwd = the snapshot, so its build state cannot
    // touch either the origin or any other session's snapshot.
    let workspaceInfo;
    try {
      workspaceInfo = await sessionWorkspace.get().prepare(
        session.id,
        project.path,
        _resolveWorkspaceOpts(project.workspace)
      );
    } catch (err) {
      logger.error('workspace prepare failed', { sessionId: session.id, error: err.message });
      return session.sendError(
        'run_flutter',
        `Could not prepare isolated workspace: ${err.message}`,
        payload?.requestId
      );
    }

    // Substitute the effective cwd. Everything downstream (spawn,
    // events, response) operates on this projected view of the
    // project; `originPath` is carried separately for logs.
    const effectiveProject = { ...project, path: workspaceInfo.workspacePath };

    const runId = _newRunId();
    const run = new FlutterRun({
      runId,
      session,
      project: effectiveProject,
      originPath: project.path,
      isolated: workspaceInfo.isolated,
      flavor,
      deviceId,
      extraArgs,
    });
    _addRun(run);

    // Auto-cleanup when the process exits — remove from registries so
    // stale runIds don't accumulate for long-lived sessions.
    const originalOnExit = () => _removeRun(runId, session.id);
    run.constructor.prototype._removeSelfOnExit = originalOnExit;

    // Backwards-compatible response: `projectPath` is still what the
    // client asked for (origin, or the registered project's path).
    // `workspacePath` + `workspaceIsolated` are additive fields
    // older clients silently ignore.
    session.sendSuccess(
      'run_flutter',
      {
        runId,
        projectId: project.id,
        projectPath: project.path,
        workspacePath: workspaceInfo.isolated ? workspaceInfo.workspacePath : null,
        workspaceIsolated: workspaceInfo.isolated,
        deviceId,
        flavor: flavor?.name ?? null,
      },
      payload?.requestId
    );
    run.start();
  },

  stop_flutter: async (session, payload) => {
    const { runId } = payload || {};
    if (!runId) return session.sendError('stop_flutter', 'runId is required', payload?.requestId);
    const run = runsByRunId.get(runId);
    if (!run) {
      return session.sendError('stop_flutter', `No active flutter run with id "${runId}"`, payload?.requestId);
    }
    if (run.session.id !== session.id) {
      return session.sendError('stop_flutter', 'You do not own this run', payload?.requestId);
    }
    session.sendSuccess('stop_flutter', { runId }, payload?.requestId);
    await run.stop();
    _removeRun(runId, session.id);
  },

  flutter_hotkey: async (session, payload) => {
    const { runId, key } = payload || {};
    if (!runId || !key) return session.sendError('flutter_hotkey', 'runId and key are required', payload?.requestId);
    const run = runsByRunId.get(runId);
    if (!run) return session.sendError('flutter_hotkey', `No active flutter run with id "${runId}"`, payload?.requestId);
    if (run.session.id !== session.id) return session.sendError('flutter_hotkey', 'You do not own this run', payload?.requestId);
    const ok = run.hotkey(key);
    session.sendSuccess('flutter_hotkey', { runId, key, delivered: ok }, payload?.requestId);
  },

  /**
   * Session-close hook — called from the WS 'close' handler in
   * server.js so a dead extension doesn't leave `flutter run`
   * subprocesses running on the remote OR isolated workspaces
   * eating disk after the session that owned them is gone.
   *
   * Order matters: kill flutter FIRST, then rm the workspace. If we
   * remove the workspace while flutter still holds file handles
   * inside it we'd get racy rm errors (esp. on Windows).
   */
  handleSessionClose: async (sessionId) => {
    const ids = runIdsBySessionId.get(sessionId);
    if (ids && ids.size > 0) {
      logger.info('cleaning up flutter runs for closed session', { sessionId, count: ids.size });
      for (const runId of Array.from(ids)) {
        const run = runsByRunId.get(runId);
        if (run) {
          try { await run.stop({ gracePeriodMs: 2000 }); }
          catch (err) { logger.warn('stop failed during cleanup', { runId, error: err.message }); }
        }
        _removeRun(runId, sessionId);
      }
    }
    // Always attempt workspace release, even if there were no active
    // runs — a `run_flutter` that failed after prepare() but before
    // spawn would still leave a snapshot behind otherwise.
    try { await sessionWorkspace.get().release(sessionId); }
    catch (err) {
      logger.warn('workspace release failed on session close', { sessionId, error: err.message });
    }
  },
};
