import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

/**
 * Launches the EmulatorDesktopApp as a child process with the
 * auto-start flags. The desktop app adopts the pre-created session
 * (the extension owns the WebSocket that created it), negotiates
 * WebRTC, and displays the stream.
 *
 * Session adoption vs. creation: passing `sessionId` tells the desktop
 * app "the extension already created a session for this device on
 * another socket — join THAT one instead of trying to create a new
 * one, which would fail because the device is already reserved."
 */
export interface StreamProcessOptions {
  desktopAppPath: string;
  server: string;
  deviceId: string;
  sessionId?: string;
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
    if (opts.sessionId) {
      args.push('--session-id', opts.sessionId);
    }

    this.emit('output', `[stream] $ ${opts.desktopAppPath} ${args.join(' ')}\n`, 'stdout');

    this.child = spawn(opts.desktopAppPath, args, {
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
