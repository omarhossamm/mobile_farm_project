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
 */
class FlutterRun {
  constructor({ runId, session, project, flavor, deviceId, extraArgs = [] }) {
    this.runId = runId;
    this.session = session;
    this.project = project;
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
    logger.info('spawn flutter', { runId: this.runId, sessionId: this.session.id, cmd, args, cwd });

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
 * WS handler exports — plug straight into server.js messageHandlers.
 */
module.exports = {
  list_projects: async (session, payload) => {
    const projects = projectRegistry.listProjects();
    session.sendSuccess('projects_list', { projects }, payload.requestId);
  },

  run_flutter: async (session, payload) => {
    const { projectId, flavorName = null, deviceId, extraArgs = [] } = payload || {};
    if (!projectId) return session.sendError('run_flutter', 'projectId is required', payload?.requestId);
    if (!deviceId)  return session.sendError('run_flutter', 'deviceId is required',  payload?.requestId);

    const project = projectRegistry.getProject(projectId);
    if (!project) {
      return session.sendError(
        'run_flutter',
        `Unknown project "${projectId}". Configure it in flutter-projects.json on the server.`,
        payload?.requestId
      );
    }
    if (!fs.existsSync(path.join(project.path, 'pubspec.yaml'))) {
      return session.sendError(
        'run_flutter',
        `Project "${projectId}" points at ${project.path} but no pubspec.yaml is there.`,
        payload?.requestId
      );
    }
    const flavor = flavorName ? projectRegistry.getFlavor(projectId, flavorName) : null;
    if (flavorName && !flavor) {
      return session.sendError(
        'run_flutter',
        `Flavor "${flavorName}" not found in project "${projectId}". ` +
        `Known: ${project.flavors.map((f) => f.name).join(', ') || '(none)'}`,
        payload?.requestId
      );
    }

    const runId = _newRunId();
    const run = new FlutterRun({ runId, session, project, flavor, deviceId, extraArgs });
    _addRun(run);

    // Auto-cleanup when the process exits — remove from registries so
    // stale runIds don't accumulate for long-lived sessions.
    const originalOnExit = () => _removeRun(runId, session.id);
    run.constructor.prototype._removeSelfOnExit = originalOnExit;

    session.sendSuccess('run_flutter', { runId, projectId, deviceId, flavor: flavor?.name ?? null }, payload?.requestId);
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
   * subprocesses running on the remote.
   */
  handleSessionClose: async (sessionId) => {
    const ids = runIdsBySessionId.get(sessionId);
    if (!ids || ids.size === 0) return;
    logger.info('cleaning up flutter runs for closed session', { sessionId, count: ids.size });
    for (const runId of Array.from(ids)) {
      const run = runsByRunId.get(runId);
      if (run) {
        try { await run.stop({ gracePeriodMs: 2000 }); }
        catch (err) { logger.warn('stop failed during cleanup', { runId, error: err.message }); }
      }
      _removeRun(runId, sessionId);
    }
  },
};
