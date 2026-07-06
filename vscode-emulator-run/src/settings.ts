import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Path of the EmulatorDesktopApp binary bundled with the extension.
 * scripts/bootstrap.js publishes the .NET project into vendor/desktop-app
 * on `npm install`.
 */
export function bundledDesktopAppPath(): string | undefined {
  const root = path.resolve(__dirname, '..', 'vendor', 'desktop-app');
  const candidates = process.platform === 'win32'
    ? [path.join(root, 'EmulatorDesktopApp.exe')]
    : [path.join(root, 'EmulatorDesktopApp')];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* ignore */ }
  }
  return undefined;
}

/**
 * Merged view of workspace settings + a launch.json configuration.
 * Everything the debug adapter / orchestrator needs to run lives here so
 * nothing outside this file touches `vscode.workspace.getConfiguration`.
 */
export interface ResolvedSettings {
  server: string;
  desktopAppPath: string | undefined;
  flutterPath: string;
  flutterProject: string;
  openStreamWindow: boolean;
  stopGracePeriodMs: number;
  device?: string;
  target?: string;
  flavor?: string;
  flutterArgs: string[];
}

export interface LaunchConfig {
  server?: string;
  device?: string;
  flutterProject?: string;
  target?: string;
  flavor?: string;
  flutterArgs?: string[];
  openStreamWindow?: boolean;
  /**
   * Optional: reference a flavor name discovered from the workspace
   * (typically the `name` of a `type: "dart"` entry in the same
   * launch.json). When set, missing fields on this config are filled
   * in from that flavor: `target`, `flavor`, extra `args`.
   */
  configName?: string;
}

const CONFIG_SECTION = 'emulatorStreamRun';

export function resolveSettings(
  launchConfig: LaunchConfig,
  workspaceFolder?: vscode.WorkspaceFolder
): ResolvedSettings {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION, workspaceFolder?.uri);

  return {
    server: firstNonEmpty([launchConfig.server, cfg.get<string>('server')]) ?? 'ws://127.0.0.1:8080',
    desktopAppPath: resolveDesktopAppPath(cfg.get<string>('desktopAppPath') ?? '', workspaceFolder),
    flutterPath: cfg.get<string>('flutterPath') || 'flutter',
    flutterProject: resolveFlutterProject(launchConfig.flutterProject, cfg.get<string>('flutterProject'), workspaceFolder),
    openStreamWindow: firstDefined([launchConfig.openStreamWindow, cfg.get<boolean>('openStreamWindow')]) ?? true,
    stopGracePeriodMs: cfg.get<number>('stopGracePeriodMs') ?? 5000,
    device: launchConfig.device?.trim() || undefined,
    target: launchConfig.target?.trim() || undefined,
    flavor: launchConfig.flavor?.trim() || undefined,
    flutterArgs: Array.isArray(launchConfig.flutterArgs) ? [...launchConfig.flutterArgs] : [],
  };
}

function firstNonEmpty(values: (string | undefined)[]): string | undefined {
  for (const v of values) if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return undefined;
}

function firstDefined<T>(values: (T | undefined)[]): T | undefined {
  for (const v of values) if (v !== undefined) return v;
  return undefined;
}

function resolveFlutterProject(
  launchOverride: string | undefined,
  settingOverride: string | undefined,
  workspaceFolder?: vscode.WorkspaceFolder
): string {
  const expanded = expandVars(launchOverride ?? settingOverride ?? '', workspaceFolder);
  if (expanded) return path.resolve(expanded);
  if (workspaceFolder) return workspaceFolder.uri.fsPath;
  return process.cwd();
}

/**
 * Resolve the EmulatorDesktopApp binary. Order:
 *   1. Explicit setting `emulatorStreamRun.desktopAppPath` (advanced users).
 *   2. The binary bundled with this extension (scripts/bootstrap.js).
 *   3. Sibling checkout: ../EmulatorDesktopApp/bin/Release/net9.0/<rid>/publish/
 *      (dev environment; picked opportunistically).
 * Returns undefined if none exist — the orchestrator surfaces a clear error.
 */
function resolveDesktopAppPath(setting: string, workspaceFolder?: vscode.WorkspaceFolder): string | undefined {
  const expanded = expandVars(setting, workspaceFolder);
  if (expanded) {
    try { if (fs.statSync(expanded).isFile()) return expanded; } catch { /* fall through */ }
  }

  const bundled = bundledDesktopAppPath();
  if (bundled) return bundled;

  const binName = process.platform === 'win32' ? 'EmulatorDesktopApp.exe' : 'EmulatorDesktopApp';
  const roots = workspaceFolder
    ? [path.join(workspaceFolder.uri.fsPath, '..', 'EmulatorDesktopApp'), path.join(workspaceFolder.uri.fsPath, 'EmulatorDesktopApp')]
    : [];
  for (const root of roots) {
    const publishGlob = ['bin', 'Release', 'net9.0'];
    try {
      const netDir = path.join(root, ...publishGlob);
      for (const rid of fs.readdirSync(netDir)) {
        const candidate = path.join(netDir, rid, 'publish', binName);
        try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
      }
    } catch { /* ignore */ }
  }
  return undefined;
}

function expandVars(value: string, workspaceFolder?: vscode.WorkspaceFolder): string {
  if (!value) return '';
  return value.replace(/\$\{workspaceFolder\}/g, workspaceFolder?.uri.fsPath ?? process.cwd());
}
