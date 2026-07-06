import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { DeviceEntry } from './serverClient';

/**
 * Spawns `flutter run -d <device_id>` as a child process and surfaces its
 * output + lifecycle to the orchestrator.
 *
 * Emits:
 *   'output' (chunk: string, category: 'stdout' | 'stderr')
 *   'started'        — matched Flutter's "Application ... started" marker
 *   'debugPort' (uri: string) — matched "Dart VM Service on ..." / "Observatory ..."
 *   'exit'    (code: number | null, signal: NodeJS.Signals | null)
 *   'error'   (err: Error)
 */
export interface FlutterRunOptions {
  flutterPath: string;
  flutterProject: string;
  device: DeviceEntry;
  target?: string;
  flavor?: string;
  extraArgs?: string[];
}

const STARTED_MARKERS = [
  /Application (.+) started\./i,
  /Syncing files to device .+\.\.\. \d+ms/i,
  /is available at:/i,
];
const VM_SERVICE_MARKERS = [
  /Dart VM Service.*at\s+(https?:\/\/\S+)/i,
  /Observatory (?:URL|listening|debug service).*(https?:\/\/\S+)/i,
];

export class FlutterRunner extends EventEmitter {
  private child: ChildProcess | null = null;
  private startedFired = false;
  private stdoutBuf = '';
  private stderrBuf = '';

  spawn(opts: FlutterRunOptions): void {
    if (this.child) throw new Error('FlutterRunner already spawned');
    if (!fs.existsSync(path.join(opts.flutterProject, 'pubspec.yaml'))) {
      throw new Error(
        `No pubspec.yaml at ${opts.flutterProject} — set "flutterProject" in launch.json or ` +
        `emulatorStreamRun.flutterProject in settings.`
      );
    }

    const args = ['run', '-d', opts.device.device_id, '--pid-file', pidFilePathFor(opts.flutterProject)];
    if (opts.target) args.push('--target', opts.target);
    if (opts.flavor) args.push('--flavor', opts.flavor);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);

    this.emit('output', `[flutter] $ ${opts.flutterPath} ${args.join(' ')}\n`, 'stdout');
    this.emit('output', `[flutter] cwd=${opts.flutterProject}\n`, 'stdout');

    this.child = spawn(opts.flutterPath, args, {
      cwd: opts.flutterProject,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.child.stdout!.on('data', (buf) => this.onChunk(buf, 'stdout'));
    this.child.stderr!.on('data', (buf) => this.onChunk(buf, 'stderr'));

    this.child.on('exit', (code, signal) => {
      this.emit('output', `[flutter] exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`, 'stdout');
      this.child = null;
      this.emit('exit', code, signal);
    });
    this.child.on('error', (err) => this.emit('error', err));
  }

  get isRunning(): boolean { return this.child !== null; }

  /**
   * Ask Flutter to shut down gracefully. Flutter's `run` command listens
   * on stdin for hotkeys — 'q' means quit. Returns true if we owned a
   * live process.
   */
  requestQuit(): boolean {
    const child = this.child;
    if (!child || child.exitCode !== null) return false;
    try {
      child.stdin?.write('q\n');
      return true;
    } catch {
      return false;
    }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.child?.kill(signal);
  }

  private onChunk(buf: Buffer, category: 'stdout' | 'stderr'): void {
    const text = buf.toString('utf8');
    this.emit('output', text, category);

    const store = category === 'stdout' ? this.stdoutBuf + text : this.stderrBuf + text;
    // Keep a rolling buffer (~4 KB) so multi-line markers still match.
    const trimmed = store.length > 4096 ? store.slice(store.length - 4096) : store;
    if (category === 'stdout') this.stdoutBuf = trimmed;
    else this.stderrBuf = trimmed;

    if (!this.startedFired) {
      for (const rx of STARTED_MARKERS) {
        if (rx.test(text) || rx.test(trimmed)) {
          this.startedFired = true;
          this.emit('started');
          break;
        }
      }
    }

    for (const rx of VM_SERVICE_MARKERS) {
      const m = text.match(rx);
      if (m && m[1]) {
        this.emit('debugPort', m[1]);
        break;
      }
    }
  }
}

function pidFilePathFor(project: string): string {
  return path.join(project, '.dart_tool', 'emulator-stream-run.pid');
}
