import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

/**
 * Launches the EmulatorDesktopApp as a child process with the auto-start
 * flags — the desktop app creates its own session, negotiates WebRTC, and
 * displays the stream. When it exits (SIGTERM from the extension on Stop,
 * or the user closing the window), its WebSocket closes and the server
 * releases the device.
 *
 * Everything session-, WebRTC-, and control-related is owned by the
 * desktop app. The extension only cares about "is it still running?".
 */
export interface StreamProcessOptions {
  desktopAppPath: string;
  server: string;
  deviceId: string;
}

export class StreamProcess extends EventEmitter {
  private child: ChildProcess | null = null;

  spawn(opts: StreamProcessOptions): void {
    if (this.child) throw new Error('StreamProcess already spawned');

    const args = [
      '--server', opts.server,
      '--device', opts.deviceId,
      '--auto-start',
    ];

    this.emit('output', `[stream] $ ${opts.desktopAppPath} ${args.join(' ')}\n`, 'stdout');

    this.child = spawn(opts.desktopAppPath, args, {
      // Detach the desktop app's own IO from ours: it has its own UI +
      // log panel, we don't need to render its stdout in the debug console.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    this.child.stdout!.on('data', (b) => this.emit('output', b.toString('utf8'), 'stdout'));
    this.child.stderr!.on('data', (b) => this.emit('output', b.toString('utf8'), 'stderr'));
    this.child.on('exit', (code, signal) => {
      this.emit('output', `[stream] desktop app exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`, 'stdout');
      this.child = null;
      this.emit('exit', code, signal);
    });
    this.child.on('error', (err) => this.emit('error', err));
  }

  get isRunning(): boolean { return this.child !== null; }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void { this.child?.kill(signal); }
}
