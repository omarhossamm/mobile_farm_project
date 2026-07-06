import * as vscode from 'vscode';
import { Orchestrator } from './orchestrator';
import { resolveSettings, type LaunchConfig } from './settings';
import { DeviceInUseError } from './devicePicker';

/**
 * Inline Debug Adapter.
 *
 * Implements the subset of DAP that VS Code needs to show the native
 * Running / Stop debug controls:
 *
 *   initialize          → advertise minimal capabilities
 *   launch              → hand off to Orchestrator.start()
 *   configurationDone   → ack
 *   disconnect/terminate→ Orchestrator.stop()
 *
 * Everything else (project + device selection, remote flutter runner,
 * stream window lifecycle) is delegated to Orchestrator.
 */
export class EmulatorStreamAdapter implements vscode.DebugAdapter {
  private readonly _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this._onDidSendMessage.event;

  private orchestrator: Orchestrator | null = null;
  private terminated = false;

  constructor(
    private readonly _session: vscode.DebugSession,
    private readonly context: vscode.ExtensionContext | undefined,
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
        this.reply(msg, { threads: [{ id: 1, name: 'emulator-stream' }] });
        return;
      default:
        this.reply(msg, {});
    }
  }

  dispose(): void {
    this._onDidSendMessage.dispose();
    if (this.orchestrator && !this.terminated) void this.orchestrator.stop('adapter_dispose');
  }

  private async handleLaunch(msg: DAPMessage): Promise<void> {
    const config = (msg.arguments ?? {}) as LaunchConfig;
    const settings = resolveSettings(config, this.workspaceFolder);
    this.info(`Server:          ${settings.server}`);
    this.info(`Desktop app:     ${settings.desktopAppPath ?? '(not bundled — stream window will not open)'}`);
    if (settings.device)    this.info(`Pinned device:   ${settings.device}`);
    if (settings.projectId) this.info(`Pinned project:  ${settings.projectId}`);
    if (settings.flavor)    this.info(`Pinned flavor:   ${settings.flavor}`);

    const workspaceKey = this.workspaceFolder?.uri.toString() ?? 'default';
    const orchestrator = new Orchestrator(workspaceKey, this.context?.workspaceState);
    this.orchestrator = orchestrator;

    orchestrator.on('output', (line: string, category: 'stdout' | 'stderr' | 'console') => {
      this.sendEvent('output', { category, output: line });
    });
    orchestrator.on('status', (status: string) => {
      this.sendEvent('output', { category: 'console', output: `▸ ${status}\n` });
    });
    orchestrator.on('terminated', () => this.finishTerminated());
    orchestrator.on('error', (err: Error) => this.info(`[extension] error: ${err.message}`));

    this.reply(msg, {});

    try {
      await orchestrator.start(settings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.info(`[extension] launch aborted: ${message}`);
      if (err instanceof DeviceInUseError) {
        void vscode.window.showWarningMessage(`Emulator Stream: ${message}`, { modal: false });
      } else {
        void vscode.window.showErrorMessage(`Emulator Stream: ${message}`);
      }
      void orchestrator.stop(`launch_failed:${message}`);
    }
  }

  private async handleStop(msg: DAPMessage, reason: string): Promise<void> {
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
