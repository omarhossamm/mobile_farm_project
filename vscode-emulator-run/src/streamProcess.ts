import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
    // The binary's mtime is the fastest way to answer "is this the
    // build I just rebuilt or a stale one from last week?". Print it
    // alongside the path so users can eyeball it against source edits
    // — the freshness helper in the orchestrator already warns loudly
    // when it doesn't advertise the required feature tags, but the
    // mtime is a nice extra sanity check on top.
    try {
      const st = fs.statSync(opts.desktopAppPath);
      this.emit(
        'output',
        `[stream] binary mtime: ${st.mtime.toISOString()} size=${st.size} bytes\n`,
        'stdout'
      );
      // On Unix, some vsix unpackers (particularly older VS Code /
      // Cursor builds) don't preserve the executable bit when they
      // extract the .vsix zip. The next `spawn` call would fail with
      // EACCES for what looks like a totally healthy binary — very
      // confusing. Defensively re-add u+x if the bit is missing.
      if (process.platform !== 'win32' && (st.mode & 0o100) === 0) {
        try {
          fs.chmodSync(opts.desktopAppPath, st.mode | 0o755);
          this.emit(
            'output',
            `[stream] restored executable bit on ${opts.desktopAppPath}\n`,
            'stdout'
          );
        } catch (chmodErr) {
          this.emit(
            'output',
            `[stream] warning: could not chmod +x ${opts.desktopAppPath}: ${
              chmodErr instanceof Error ? chmodErr.message : String(chmodErr)
            }\n`,
            'stderr'
          );
        }
      }
    } catch { /* stat failure isn't fatal — spawn will report the real error */ }
    // Windows WinExe apps detach stdout, so the desktop app writes a
    // parallel diagnostic log to os.tmpdir(). Print the path so users
    // don't have to hunt for it after a bad launch.
    this.emit(
      'output',
      `[stream] startup log: ${path.join(os.tmpdir(), 'EmulatorDesktopApp.log')}\n`,
      'stdout'
    );

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
