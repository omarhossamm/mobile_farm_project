import * as vscode from 'vscode';
import { EmulatorStreamAdapter } from './debugAdapter';
import type { LaunchConfig } from './settings';
import { fetchDevices } from './serverClient';
import { registerRebuildCommand } from './rebuildCommand';
import { registerDoctorCommand } from './doctorCommand';
import { DesktopAppInstaller, currentRid } from './desktopAppInstaller';

const DEBUG_TYPE = 'emulator-stream';
const RUN_COMMAND = 'emulatorStreamRun.run';

let statusBarItem: vscode.StatusBarItem | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
/**
 * Process-wide installer singleton. Owns the in-flight download map,
 * the lock file table, and the background updater state. Constructed
 * once on activate() and reused for every F5 + doctor invocation.
 */
let installer: DesktopAppInstaller | undefined;

/** Accessor for other modules that want the installer without going through activate(). */
export function getDesktopAppInstaller(): DesktopAppInstaller {
  if (!installer) throw new Error('DesktopAppInstaller accessed before extension activated');
  return installer;
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  installer = new DesktopAppInstaller();

  // Ensure the global-storage folder exists BEFORE anyone tries to
  // write into it. VS Code doesn't create this lazily.
  try {
    require('fs').mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
  } catch { /* best effort */ }

  // Background downloads are disabled for the offline per-platform VSIX
  // distribution model. The bundled binary inside vendor/desktop-app/ is
  // the only supported source at F5 time.
  void installer.checkForUpdatesInBackground({
    cacheRoot: context.globalStorageUri.fsPath,
    enabled: false,
  });

  const provider = new EmulatorStreamConfigProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, provider, vscode.DebugConfigurationProviderTriggerKind.Initial),
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, provider, vscode.DebugConfigurationProviderTriggerKind.Dynamic)
  );

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
      createDebugAdapterDescriptor(session) {
        return new vscode.DebugAdapterInlineImplementation(
          new EmulatorStreamAdapter(session, extensionContext, session.workspaceFolder)
        );
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(RUN_COMMAND, () => runOnActiveFolder())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('emulatorStreamRun.pickDevice', () => listDevicesInteractive())
  );

  registerRebuildCommand(context);
  registerDoctorCommand(context);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(play-circle) Emulator Stream';
  statusBarItem.tooltip = 'Run a remote Flutter project on a remote device (Emulator Stream)';
  statusBarItem.command = RUN_COMMAND;
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
}

export function deactivate(): void {
  extensionContext = undefined;
  installer = undefined;
}

// Suppress unused warning while keeping the export ergonomic.
void currentRid;

// ── Commands ────────────────────────────────────────────────────────────

/**
 * Kick off a debug session with an empty launch config — the orchestrator
 * will prompt the user for device/project/flavor. Works even when no
 * `.vscode/launch.json` exists locally, because Flutter isn't on this box.
 */
async function runOnActiveFolder(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const config: vscode.DebugConfiguration & LaunchConfig = {
    type: DEBUG_TYPE,
    request: 'launch',
    name: 'Emulator Stream',
  };
  const started = await vscode.debug.startDebugging(folder, config);
  if (!started) {
    void vscode.window.showErrorMessage('Emulator Stream: failed to start debug session.');
  }
}

async function listDevicesInteractive(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('emulatorStreamRun');
  const server = cfg.get<string>('server') || 'ws://127.0.0.1:8080';
  try {
    const devices = await fetchDevices(server);
    if (devices.length === 0) {
      void vscode.window.showInformationMessage('Emulator Stream: no devices returned by the server.');
      return;
    }
    interface Item extends vscode.QuickPickItem { deviceId: string; }
    const items: Item[] = devices.map((d) => ({
      label: d.name ?? d.avd_name ?? d.device_id,
      description: `${d.platform ?? '?'} · ${d.status ?? '?'}${d.in_use ? ' · in use' : ''}`,
      detail: d.device_id,
      deviceId: d.device_id,
    }));
    const picked = await vscode.window.showQuickPick(items, { title: `Devices on ${server}` });
    if (picked) {
      void vscode.env.clipboard.writeText(picked.deviceId);
      void vscode.window.showInformationMessage(
        `Copied device id "${picked.deviceId}" to clipboard.`
      );
    }
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Emulator Stream: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ── Config provider ─────────────────────────────────────────────────────

class EmulatorStreamConfigProvider implements vscode.DebugConfigurationProvider {
  /**
   * Seed a fresh .vscode/launch.json with a single stub — the actual
   * project + flavor pickers come from the server at runtime, so we
   * don't need one config-per-flavor like the local version did.
   */
  async provideDebugConfigurations(): Promise<vscode.DebugConfiguration[]> {
    return [
      {
        type: DEBUG_TYPE,
        request: 'launch',
        name: 'Emulator Stream',
      },
    ];
  }

  /**
   * Called before the debug session starts. Fills in the type/name
   * defaults when the user hits F5 with no launch.json entry.
   */
  async resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration
  ): Promise<vscode.DebugConfiguration | null | undefined> {
    const cfg = config as vscode.DebugConfiguration & LaunchConfig;
    if (!cfg.type) {
      cfg.type = DEBUG_TYPE;
      cfg.request = 'launch';
      cfg.name = 'Emulator Stream';
    }
    return cfg;
  }
}
