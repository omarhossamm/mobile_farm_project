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
 * Everything the debug adapter / orchestrator needs at runtime.
 *
 * Note the intentional absence of `flutterPath`, `flutterProject`,
 * `flavorDiscovery`, etc. — those all belong on the remote server
 * host, not the developer's machine, per the thin-client design.
 */
export interface ResolvedSettings {
  server: string;
  desktopAppPath: string | undefined;
  openStreamWindow: boolean;
  stopGracePeriodMs: number;
  device?: string;
  projectId?: string;
  flavor?: string;
  flutterArgs: string[];
}

export interface LaunchConfig {
  server?: string;
  device?: string;
  /** Server-side project id (from flutter-projects.json on the remote). */
  projectId?: string;
  /** Server-side flavor name (as listed for that project). */
  flavor?: string;
  /** Extra args to pass to `flutter run` on the remote. */
  flutterArgs?: string[];
  openStreamWindow?: boolean;
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
    openStreamWindow: firstDefined([launchConfig.openStreamWindow, cfg.get<boolean>('openStreamWindow')]) ?? true,
    stopGracePeriodMs: cfg.get<number>('stopGracePeriodMs') ?? 5000,
    device: launchConfig.device?.trim() || undefined,
    projectId: launchConfig.projectId?.trim() || undefined,
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

function resolveDesktopAppPath(setting: string, workspaceFolder?: vscode.WorkspaceFolder): string | undefined {
  const expanded = setting ? expandVars(setting, workspaceFolder) : '';
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
    try {
      const netDir = path.join(root, 'bin', 'Release', 'net10.0');
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
