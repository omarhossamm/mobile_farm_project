import * as vscode from 'vscode';
import * as path from 'path';

/**
 * A distinct way of launching the Flutter app that the extension can
 * offer to the user. Each flavor gets:
 *  - a display `name` (unique per workspace)
 *  - an optional Dart entry point (`target`, e.g. "lib/main_staging.dart")
 *  - an optional Flutter `--flavor` value
 *  - any remaining extra args
 *
 * Sources: existing `type: "dart"` entries in the workspace's
 * `.vscode/launch.json`, plus `lib/main*.dart` files on disk.
 */
export interface FlutterFlavor {
  name: string;
  target?: string;
  flavor?: string;
  args?: string[];
  source: 'launch.json' | 'lib/main_*.dart';
}

/** Discover flavors for a workspace folder (returns [] if nothing to pick). */
export async function discoverFlavors(folder: vscode.WorkspaceFolder): Promise<FlutterFlavor[]> {
  const fromLaunch = readLaunchJsonFlavors(folder);
  const fromFs = await scanMainFiles(folder);
  return dedupe([...fromLaunch, ...fromFs]);
}

/**
 * Extract every `type: "dart"` config from the workspace's launch.json
 * (VS Code's config API handles comments / trailing commas for us).
 */
function readLaunchJsonFlavors(folder: vscode.WorkspaceFolder): FlutterFlavor[] {
  const launchCfg = vscode.workspace.getConfiguration('launch', folder.uri);
  const configs = launchCfg.get<unknown[]>('configurations') ?? [];
  const out: FlutterFlavor[] = [];
  for (const cfg of configs) {
    if (!isRecord(cfg)) continue;
    if (cfg.type !== 'dart') continue;
    const parsed = parseDartConfig(cfg);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseDartConfig(cfg: Record<string, unknown>): FlutterFlavor | undefined {
  const rawArgs = Array.isArray(cfg.args) ? cfg.args.map((a) => String(a)) : [];
  let flavor: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const tok = rawArgs[i];
    if (tok === '--flavor') {
      flavor = rawArgs[i + 1] ?? '';
      i++;
      continue;
    }
    if (tok.startsWith('--flavor=')) {
      flavor = tok.slice('--flavor='.length);
      continue;
    }
    rest.push(tok);
  }
  const name = typeof cfg.name === 'string' && cfg.name.trim().length > 0
    ? cfg.name.trim()
    : flavor ?? 'default';
  const target = typeof cfg.program === 'string' && cfg.program.trim().length > 0
    ? cfg.program.trim()
    : undefined;
  return {
    name,
    target,
    flavor,
    args: rest.length ? rest : undefined,
    source: 'launch.json',
  };
}

/** Discover flavors from `lib/main*.dart` filenames. */
async function scanMainFiles(folder: vscode.WorkspaceFolder): Promise<FlutterFlavor[]> {
  const rel = new vscode.RelativePattern(folder, 'lib/main*.dart');
  const excl = new vscode.RelativePattern(folder, '**/{.dart_tool,build,.git,node_modules}/**');
  let uris: vscode.Uri[] = [];
  try {
    uris = await vscode.workspace.findFiles(rel, excl, 50);
  } catch {
    return [];
  }
  return uris.map<FlutterFlavor>((uri) => {
    const base = path.basename(uri.fsPath, '.dart');
    // "main"           → no flavor, target lib/main.dart
    // "main_dev"       → flavor dev
    // "main_ntgStaging"→ flavor ntgStaging
    const flavor = base === 'main' ? undefined : base.replace(/^main[_-]/, '');
    return {
      name: flavor ?? 'default',
      target: path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/'),
      flavor,
      source: 'lib/main_*.dart',
    };
  });
}

function dedupe(list: FlutterFlavor[]): FlutterFlavor[] {
  // Suppress duplicates in two ways, always preferring the earlier
  // entry (launch.json items come first, so they win):
  //   1. Same display name.
  //   2. Same underlying `target` path (e.g. lib/main_ntg_staging.dart
  //      is already covered by a launch.json entry called "ntgStaging"
  //      — no reason to also show the fs-derived "ntg_staging").
  const byName = new Set<string>();
  const byTarget = new Set<string>();
  const out: FlutterFlavor[] = [];
  for (const f of list) {
    if (byName.has(f.name)) continue;
    const targetKey = f.target?.replace(/\\/g, '/').toLowerCase();
    if (targetKey && byTarget.has(targetKey)) continue;
    byName.add(f.name);
    if (targetKey) byTarget.add(targetKey);
    out.push(f);
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Look up a flavor by name; case-insensitive fallback. */
export function findFlavor(list: FlutterFlavor[], name: string): FlutterFlavor | undefined {
  const trimmed = name.trim();
  return (
    list.find((f) => f.name === trimmed) ??
    list.find((f) => f.name.toLowerCase() === trimmed.toLowerCase())
  );
}
