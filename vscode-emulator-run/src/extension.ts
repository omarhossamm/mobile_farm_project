import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EmulatorStreamAdapter } from './debugAdapter';
import type { LaunchConfig } from './settings';
import { fetchDevices } from './serverClient';
import { discoverFlavors, findFlavor, FlutterFlavor } from './flavorDiscovery';

const DEBUG_TYPE = 'emulator-stream';
const RUN_COMMAND = 'emulatorStreamRun.run';
const LAST_FLAVOR_KEY = 'emulatorStreamRun.lastFlavor';

let statusBarItem: vscode.StatusBarItem | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;

  const provider = new EmulatorStreamConfigProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, provider, vscode.DebugConfigurationProviderTriggerKind.Initial),
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, provider, vscode.DebugConfigurationProviderTriggerKind.Dynamic)
  );

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
      createDebugAdapterDescriptor(session) {
        return new vscode.DebugAdapterInlineImplementation(
          new EmulatorStreamAdapter(session, session.workspaceFolder)
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

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(play-circle) Emulator Stream';
  statusBarItem.tooltip = 'Run this Flutter project on a remote emulator/simulator (Emulator Stream)';
  statusBarItem.command = RUN_COMMAND;
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => updateStatusBar())
  );
  updateStatusBar();
}

export function deactivate(): void {
  extensionContext = undefined;
}

// ── Commands ────────────────────────────────────────────────────────────

async function runOnActiveFolder(): Promise<void> {
  const folder = pickPrimaryFolder();
  if (!folder) {
    void vscode.window.showErrorMessage(
      'Emulator Stream: open a Flutter project (containing pubspec.yaml) first.'
    );
    return;
  }
  if (!hasPubspec(folder)) {
    void vscode.window.showErrorMessage(
      `Emulator Stream: no pubspec.yaml found in "${folder.name}". ` +
      `Open the folder that contains your Flutter project.`
    );
    return;
  }

  const flavors = await discoverFlavors(folder);
  const chosen = await pickFlavorInteractive(folder, flavors);
  if (chosen === undefined) return; // user cancelled the QP

  const config: vscode.DebugConfiguration & LaunchConfig = buildLaunchConfigFromFlavor(
    folder,
    chosen ?? undefined
  );
  const started = await vscode.debug.startDebugging(folder, config);
  if (!started) {
    void vscode.window.showErrorMessage('Emulator Stream: failed to start debug session.');
  }
}

/**
 * Prompt for a flavor. Returns:
 *   - the flavor the user picked,
 *   - `null` when there was nothing to pick from (run with defaults),
 *   - `undefined` when the user hit Escape (cancel the whole run).
 */
async function pickFlavorInteractive(
  folder: vscode.WorkspaceFolder,
  flavors: FlutterFlavor[]
): Promise<FlutterFlavor | null | undefined> {
  if (flavors.length === 0) return null;

  // Fast path: only one → don't bother the user.
  if (flavors.length === 1) return flavors[0];

  const last = extensionContext?.workspaceState.get<string>(
    `${LAST_FLAVOR_KEY}:${folder.uri.toString()}`
  );

  interface Item extends vscode.QuickPickItem { flavor: FlutterFlavor | null; }
  const items: Item[] = flavors.map((f) => ({
    label: f.name,
    description: describeFlavor(f),
    detail: `Source: ${f.source}`,
    picked: f.name === last,
    flavor: f,
  }));
  items.push({
    label: '$(gear) Default',
    description: 'no target / no flavor',
    detail: 'Uses lib/main.dart with no --flavor',
    flavor: null,
  });

  // Move last-used to the top so it's the default action.
  if (last) {
    const idx = items.findIndex((it) => it.flavor?.name === last);
    if (idx > 0) items.unshift(...items.splice(idx, 1));
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Emulator Stream: choose flavor',
    placeHolder: last ? `Last used: ${last}` : 'Pick which Flutter flavor / entry point to run',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return undefined; // Escape

  if (picked.flavor && extensionContext) {
    await extensionContext.workspaceState.update(
      `${LAST_FLAVOR_KEY}:${folder.uri.toString()}`,
      picked.flavor.name
    );
  }
  return picked.flavor;
}

function describeFlavor(f: FlutterFlavor): string {
  const bits: string[] = [];
  if (f.flavor) bits.push(`--flavor ${f.flavor}`);
  if (f.target) bits.push(f.target);
  if (f.args && f.args.length) bits.push(f.args.join(' '));
  return bits.join(' · ');
}

function buildLaunchConfigFromFlavor(
  folder: vscode.WorkspaceFolder,
  flavor: FlutterFlavor | undefined
): vscode.DebugConfiguration & LaunchConfig {
  const label = flavor ? `Emulator Stream: ${flavor.name}` : 'Emulator Stream';
  const config: vscode.DebugConfiguration & LaunchConfig = {
    type: DEBUG_TYPE,
    request: 'launch',
    name: label,
    flutterProject: folder.uri.fsPath,
  };
  if (flavor?.target) config.target = flavor.target;
  if (flavor?.flavor) config.flavor = flavor.flavor;
  if (flavor?.args?.length) config.flutterArgs = [...flavor.args];
  return config;
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
      description: `${d.platform ?? '?'} · ${d.status ?? '?'}`,
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
   * Populate the F5 dropdown with one entry per discovered flavor.
   *
   * VS Code calls this two ways:
   *  - `TriggerKind.Initial`: to seed a fresh .vscode/launch.json
   *  - `TriggerKind.Dynamic`: for the "Show all automatic debug
   *    configurations" list under the Run/Debug panel.
   */
  async provideDebugConfigurations(
    folder: vscode.WorkspaceFolder | undefined
  ): Promise<vscode.DebugConfiguration[]> {
    if (!folder) return [defaultConfigStub('${workspaceFolder}')];
    const flavors = await discoverFlavors(folder);
    if (flavors.length === 0) return [defaultConfigStub(folder.uri.fsPath)];
    return flavors.map((f) => ({
      type: DEBUG_TYPE,
      request: 'launch',
      name: `Emulator Stream: ${f.name}`,
      flutterProject: folder.uri.fsPath,
      ...(f.target ? { target: f.target } : {}),
      ...(f.flavor ? { flavor: f.flavor } : {}),
      ...(f.args?.length ? { flutterArgs: f.args } : {}),
    }));
  }

  /**
   * Called just before the debug session starts. Fills in defaults for
   * the empty-config case (F5 without launch.json) and expands
   * `configName` references against the workspace's discovered flavors.
   */
  async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration
  ): Promise<vscode.DebugConfiguration | null | undefined> {
    const cfg = config as vscode.DebugConfiguration & LaunchConfig;

    // Empty config (F5 with no launch.json entries) → synthesize.
    if (!cfg.type) {
      cfg.type = DEBUG_TYPE;
      cfg.request = 'launch';
      cfg.name = 'Emulator Stream';
    }
    if (!cfg.flutterProject && folder) cfg.flutterProject = folder.uri.fsPath;

    // Expand configName → pull target/flavor/args from a discovered flavor.
    if (folder && cfg.configName) {
      const flavors = await discoverFlavors(folder);
      const found = findFlavor(flavors, cfg.configName);
      if (!found) {
        void vscode.window.showErrorMessage(
          `Emulator Stream: configName "${cfg.configName}" was not found in this workspace. ` +
          `Known flavors: ${flavors.map((f) => f.name).join(', ') || '(none)'}.`
        );
        return null; // abort launch
      }
      if (cfg.target === undefined && found.target) cfg.target = found.target;
      if (cfg.flavor === undefined && found.flavor) cfg.flavor = found.flavor;
      if ((cfg.flutterArgs === undefined || cfg.flutterArgs.length === 0) && found.args?.length) {
        cfg.flutterArgs = [...found.args];
      }
      if (!cfg.name || cfg.name === 'Emulator Stream') {
        cfg.name = `Emulator Stream: ${found.name}`;
      }
    }
    return cfg;
  }
}

function defaultConfigStub(flutterProject: string): vscode.DebugConfiguration {
  return {
    type: DEBUG_TYPE,
    request: 'launch',
    name: 'Emulator Stream',
    flutterProject,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function pickPrimaryFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const withPubspec = folders.find(hasPubspec);
  return withPubspec ?? folders[0];
}

function hasPubspec(folder: vscode.WorkspaceFolder): boolean {
  try { return fs.statSync(path.join(folder.uri.fsPath, 'pubspec.yaml')).isFile(); }
  catch { return false; }
}

function updateStatusBar(): void {
  if (!statusBarItem) return;
  const folder = pickPrimaryFolder();
  if (folder && hasPubspec(folder)) statusBarItem.show();
  else statusBarItem.hide();
}
