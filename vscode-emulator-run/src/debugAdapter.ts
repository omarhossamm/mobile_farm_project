import * as vscode from 'vscode';
import { Orchestrator } from './orchestrator';
import { resolveSettings, type LaunchConfig } from './settings';
import { DeviceInUseError } from './devicePicker';

/**
 * Inline Debug Adapter.
 *
 * We implement the tiny subset of DAP needed to make VS Code show the
 * native "Running" state with a Stop button:
 *
 *   initialize          → reply with minimal capabilities
 *   launch              → kick off the orchestrator
 *   configurationDone   → ack, orchestrator continues on its own
 *   disconnect          → ordered shutdown
 *
 * All Flutter stdout/stderr and our own status messages come out as
 * DAP `output` events. When everything is torn down we emit
 * `terminated` which cleanly ends the debug session.
 */
export class EmulatorStreamAdapter implements vscode.DebugAdapter {
  private readonly _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this._onDidSendMessage.event;

  private orchestrator: Orchestrator | null = null;
  private terminated = false;

  constructor(
    private readonly session: vscode.DebugSession,
    private readonly workspaceFolder?: vscode.WorkspaceFolder
  ) {}

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const msg = message as DAPMessage;
    switch (msg.command) {
      case 'initialize':
        this.reply(msg, {
          supportsConfigurationDoneRequest: true,
          supportsTerminateRequest: true,
        });
        this.sendEvent('initialized');
        return;
      case 'launch':
        void this.handleLaunch(msg);
        return;
      case 'configurationDone':
        this.reply(msg, {});
        return;
      case 'disconnect':
      case 'terminate':
        void this.handleStop(msg, msg.command === 'terminate' ? 'terminate' : 'disconnect');
        return;
      case 'threads':
        // VS Code sometimes asks; we're not really a debugger, so return
        // a single fake thread to satisfy the client.
        this.reply(msg, { threads: [{ id: 1, name: 'emulator-stream' }] });
        return;
      default:
        // Unknown → reply with an empty body so VS Code doesn't stall.
        this.reply(msg, {});
    }
  }

  dispose(): void {
    this._onDidSendMessage.dispose();
    if (this.orchestrator && !this.terminated) void this.orchestrator.stop('adapter_dispose');
  }

  // ── Handlers ───────────────────────────────────────────────────────────

  private async handleLaunch(msg: DAPMessage): Promise<void> {
    const config = (msg.arguments ?? {}) as LaunchConfig;
    const settings = resolveSettings(config, this.workspaceFolder);
    this.info(`Server:          ${settings.server}`);
    this.info(`Desktop app:     ${settings.desktopAppPath ?? '(not bundled — will refuse to open stream window)'}`);
    this.info(`Flutter path:    ${settings.flutterPath}`);
    this.info(`Flutter project: ${settings.flutterProject}`);
    if (settings.device) this.info(`Pinned device:   ${settings.device}`);

    const orchestrator = new Orchestrator();
    this.orchestrator = orchestrator;

    orchestrator.on('output', (line: string, category: 'stdout' | 'stderr' | 'console') => {
      this.sendEvent('output', { category, output: line });
    });
    orchestrator.on('status', (status: string) => {
      // Also emit as a "console" output for a nice log trail.
      this.sendEvent('output', { category: 'console', output: `▸ ${status}\n` });
    });
    orchestrator.on('terminated', () => this.finishTerminated());
    orchestrator.on('error', (err: Error) => this.info(`[extension] error: ${err.message}`));

    // Reply to launch immediately so VS Code shows Running. The
    // orchestrator does the real work asynchronously.
    this.reply(msg, {});

    try {
      await orchestrator.start(settings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.info(`[extension] launch aborted: ${message}`);
      // Device-in-use gets a warning (it's a user-recoverable state:
      // "pick another device"), everything else stays a hard error.
      if (err instanceof DeviceInUseError) {
        void vscode.window.showWarningMessage(
          `Emulator Stream: ${message}`,
          { modal: false }
        );
      } else {
        void vscode.window.showErrorMessage(`Emulator Stream: ${message}`);
      }
      void orchestrator.stop(`launch_failed:${message}`);
    }
  }

  private async handleStop(msg: DAPMessage, reason: string): Promise<void> {
    // Reply immediately so VS Code doesn't hang on the request.
    this.reply(msg, {});
    if (this.orchestrator) await this.orchestrator.stop(`vscode_${reason}`);
    else this.finishTerminated();
  }

  private finishTerminated(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.sendEvent('terminated');
    this.sendEvent('exited', { exitCode: 0 });
  }

  // ── DAP wire helpers ───────────────────────────────────────────────────

  private reply(request: DAPMessage, body: Record<string, unknown>): void {
    this._onDidSendMessage.fire({
      type: 'response',
      request_seq: request.seq,
      success: true,
      command: request.command,
      body,
    } as unknown as vscode.DebugProtocolMessage);
  }

  private sendEvent(event: string, body?: Record<string, unknown>): void {
    this._onDidSendMessage.fire({
      type: 'event',
      event,
      body,
    } as unknown as vscode.DebugProtocolMessage);
  }

  private info(line: string): void {
    this.sendEvent('output', { category: 'console', output: line + '\n' });
  }
}

interface DAPMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
  command: string;
  arguments?: unknown;
}
