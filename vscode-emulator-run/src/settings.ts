import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  type DesktopAppInfo,
  type DesktopAppOrigin,
  type DesktopAppDiagnostics,
  findMissingFeatures,
  readBuildInfo,
  statMtime,
} from './desktopAppFreshness';
import { PINNED_MANIFEST } from './desktopAppManifest';
export type { DesktopAppInfo } from './desktopAppFreshness';

/**
 * Absolute path of the vendor root the packaging pipeline populates.
 * Exported so diagnostic commands + doctor UI can point at the same
 * folder without duplicating this bit of layout knowledge.
 *
 * The vsix layout (per-platform offline bundle) is flat:
 *
 *   vendor/desktop-app/
 *   ├── EmulatorDesktopApp[.exe]
 *   ├── BUILD_INFO.json
 *   ├── ffmpeg/win-x64/…        (Windows only)
 *   └── … (other native deps for this platform only)
 *
 * Each platform-specific `.vsix` ships exactly one publish output.
 * Runtime resolution: look for `vendor/desktop-app/EmulatorDesktopApp[.exe]`.
 * A legacy per-RID subfolder (`vendor/desktop-app/<rid>/`) is still
 * accepted for older packages.
 *
 * `__dirname` at runtime is `<extension>/out/`; the compiled JS lives
 * one level below the extension root.
 */
export function bundledDesktopAppDir(): string {
  return path.resolve(__dirname, '..', 'vendor', 'desktop-app');
}

/**
 * .NET runtime identifier that matches the host we're running on.
 *
 * Callers can pass an override (from `emulatorStreamRun.desktopAppRid`)
 * for edge cases — e.g. forcing `osx-x64` on an Apple Silicon Mac to
 * run the Intel binary under Rosetta 2.
 */
export function currentRid(override?: string): string {
  if (override && override.trim()) return override.trim();
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin') return arch === 'arm64' ? 'osx-arm64' : 'osx-x64';
  if (platform === 'linux')  return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  if (platform === 'win32')  return arch === 'arm64' ? 'win-arm64'  : 'win-x64';
  return `${platform}-${arch}`;
}

/**
 * Every RID we know how to talk about, in order of preference for
 * fallback (host RID first). Used for diagnostic messages so the user
 * sees a list they can act on.
 */
const SUPPORTED_RIDS = [
  'win-x64', 'win-arm64',
  'osx-x64', 'osx-arm64',
  'linux-x64', 'linux-arm64',
] as const;

/**
 * Locate the packaged EmulatorDesktopApp binary AND record enough
 * detail about the lookup that we can print a genuinely useful error
 * message when it fails.
 *
 * Two probing strategies, in order:
 *   1. **Multi-platform layout** (`vendor/desktop-app/<rid>/…`) —
 *      the new self-selecting bundle. If the host's RID subdirectory
 *      exists and contains the expected binary, we're done.
 *   2. **Legacy flat layout** (`vendor/desktop-app/…`) — kept as a
 *      fallback so a `.vsix` built before the multi-platform switch
 *      keeps working. The extension still functions; the diagnostic
 *      report notes it's a legacy layout so the user knows to
 *      rebuild for the modern one.
 *
 * @param options.rid         Optional override — treat this as the
 *                            host RID instead of `currentRid()`.
 *                            Meant for the `emulatorStreamRun.desktopAppRid`
 *                            user setting.
 * @param options.vendorRoot  Optional override — probe this
 *                            directory instead of the extension's
 *                            own `vendor/desktop-app/`. Only used by
 *                            tests and diagnostic tooling that
 *                            wants to inspect an arbitrary bundle.
 */
export function findBundledDesktopApp(
  options: { rid?: string; vendorRoot?: string } = {}
): { path?: string; diagnostics: DesktopAppDiagnostics } {
  const root = options.vendorRoot ?? bundledDesktopAppDir();
  const rid = currentRid(options.rid);
  const expected = expectedBinaryName();

  // ── Probe A: flat layout (per-platform offline VSIX). ─────────────
  const legacyPath = path.join(root, expected);

  // ── Probe B: per-RID subdirectory (legacy multi-RID bundles). ──
  const ridDir = path.join(root, rid);
  const ridPath = path.join(ridDir, expected);

  const probedPaths = [legacyPath, ridPath];

  const rootExists = safeIsDir(root);
  const rootContents = rootExists ? safeReaddir(root) : undefined;
  const availableRids = detectAvailableRids(root, rootContents);
  const ridDirExists = safeIsDir(ridDir);
  const ridDirContents = ridDirExists ? safeReaddir(ridDir) : undefined;

  const diagnostics: DesktopAppDiagnostics = {
    extensionPlatform: `${process.platform}/${process.arch}`,
    hostRid: rid,
    expectedBinaryName: expected,
    probedPaths,
    vendorDir: root,
    vendorExists: rootExists,
    vendorContents: rootContents,
    ridSubdir: ridDir,
    ridSubdirExists: ridDirExists,
    ridSubdirContents: ridDirContents,
    availableRids,
    ridOverride: options.rid,
    likelyWrongPlatform: undefined,   // filled below only if we hit the missing branch
  };

  // Prefer per-RID subdirectory when this bundle ships multiple platforms.
  if (availableRids.length > 1 && safeIsFile(ridPath)) {
    return { path: ridPath, diagnostics };
  }

  // Flat layout (single-platform offline VSIX).
  if (safeIsFile(legacyPath)) {
    return { path: legacyPath, diagnostics };
  }

  // Per-RID subdirectory (universal or legacy bundles).
  if (safeIsFile(ridPath)) {
    diagnostics.legacyFallbackUsed = true;
    return { path: ridPath, diagnostics };
  }

  // Missing — enrich diagnostics with a guess at what happened.
  diagnostics.likelyWrongPlatform = detectWrongPlatform(diagnostics);
  return { diagnostics };
}

/**
 * Legacy narrow accessor kept for call sites that only care about the
 * path. New code should prefer `findBundledDesktopApp()`.
 */
export function bundledDesktopAppPath(): string | undefined {
  return findBundledDesktopApp().path;
}

function expectedBinaryName(): string {
  return process.platform === 'win32' ? 'EmulatorDesktopApp.exe' : 'EmulatorDesktopApp';
}

function safeIsFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function safeIsDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function safeReaddir(p: string): string[] | undefined {
  try { return fs.readdirSync(p).sort(); } catch { return undefined; }
}

/**
 * List RIDs that are actually present inside `vendor/desktop-app/`.
 * We only report a RID as "available" if the expected binary is
 * genuinely there — an empty subdir doesn't count. This is what the
 * doctor / freshness reporter shows in the "the bundle ships builds
 * for [osx-arm64, win-x64] but not for your host" case.
 */
function detectAvailableRids(root: string, rootContents: string[] | undefined): string[] {
  if (!rootContents) return [];
  const found: string[] = [];
  for (const name of rootContents) {
    if (!(SUPPORTED_RIDS as readonly string[]).includes(name)) continue;
    const isWinLike = name.startsWith('win-');
    const bin = path.join(root, name, isWinLike ? 'EmulatorDesktopApp.exe' : 'EmulatorDesktopApp');
    if (safeIsFile(bin)) found.push(name);
  }
  return found;
}

/**
 * Turn a `missing` result into an educated guess about *why*. The
 * three states we distinguish:
 *
 *   1. Host RID's subdir exists AND has files but the binary is
 *      missing (renamed / partial extraction) — rare.
 *   2. Host RID's subdir doesn't exist at all — bundle ships for
 *      other RIDs but not this host. Message includes the list of
 *      RIDs that ARE present so the user knows whether the vsix was
 *      built wrong or the host is unsupported.
 *   3. Legacy flat layout is present but for the wrong platform —
 *      the pre-multi-platform failure mode. Detect via
 *      BUILD_INFO.json under root, or filename shape.
 */
function detectWrongPlatform(d: DesktopAppDiagnostics):
  { installedRid?: string; installedFor?: string; note?: string } | undefined {
  // Case: multi-platform layout, but we don't have this host's RID.
  if (d.availableRids && d.availableRids.length > 0 && !d.availableRids.includes(d.hostRid)) {
    return {
      installedFor: d.availableRids.join(', '),
      note: 'multi-platform bundle without support for this host',
    };
  }

  // Case: legacy flat layout with BUILD_INFO.json → check rid mismatch.
  const rootBuildInfoPath = path.join(d.vendorDir, 'BUILD_INFO.json');
  if (safeIsFile(rootBuildInfoPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(rootBuildInfoPath, 'utf8')) as { rid?: string };
      if (info?.rid && info.rid !== d.hostRid) {
        return { installedRid: info.rid, installedFor: ridToVscePlatform(info.rid) ?? info.rid };
      }
    } catch { /* fall through */ }
  }

  // Case: legacy flat layout — filename shape mismatch.
  const contents = d.vendorContents ?? [];
  const isWin = process.platform === 'win32';
  const hasExe = contents.some((n) => n.toLowerCase() === 'emulatordesktopapp.exe');
  const hasUnix = contents.some((n) => n === 'EmulatorDesktopApp');
  if (isWin && hasUnix && !hasExe) {
    return { installedFor: 'darwin or linux (no .exe present at vendor root)' };
  }
  if (!isWin && hasExe && !hasUnix) {
    return { installedFor: 'win32 (only .exe present at vendor root)' };
  }
  return undefined;
}

function ridToVscePlatform(rid: string): string | undefined {
  const map: Record<string, string> = {
    'win-x64': 'win32-x64',
    'win-arm64': 'win32-arm64',
    'osx-x64': 'darwin-x64',
    'osx-arm64': 'darwin-arm64',
    'linux-x64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
  };
  return map[rid];
}

// os import kept for future use (e.g. surfacing hostname in doctor).
void os;

/**
 * Everything the debug adapter / orchestrator needs at runtime.
 *
 * Note the intentional absence of `flutterPath`, `flutterProject`,
 * `flavorDiscovery`, etc. — those all belong on the remote server
 * host, not the developer's machine, per the thin-client design.
 */
export interface ResolvedSettings {
  server: string;
  /**
   * PRELIMINARY resolution — reflects only what the extension can
   * determine synchronously from a bundled fallback or an explicit
   * `desktopAppPath` override. First-run installs live in the
   * installer's cache and only become visible AFTER the orchestrator
   * calls `installer.ensure()`; until then `origin` may be
   * `'missing'` even though the binary is about to be downloaded.
   *
   * Use `settings.desktopApp` for logging + doctor introspection.
   * Use the value returned by `installer.ensure()` for spawning.
   */
  desktopApp: DesktopAppInfo;
  /**
   * The user-configurable base URL for downloading the desktop-app
   * archive. Empty string = accept whatever the pinned manifest
   * defaults to (typically the maintainer's GitHub Releases).
   */
  desktopAppBaseUrl: string;
  /**
   * Explicit RID override for the installer (Rosetta 2, cross-arch
   * containers, …). Empty = auto-detect from process.platform/arch.
   */
  desktopAppRid: string;
  /**
   * When set, extension will silently download newer compatible
   * versions in the background and cache them for next-launch use.
   */
  autoUpdateDesktopApp: boolean;
  openStreamWindow: boolean;
  stopGracePeriodMs: number;
  device?: string;
  projectId?: string;
  /**
   * Absolute path on the REMOTE machine to a Flutter checkout. When
   * set, the extension bypasses the server's `flutter-projects.json`
   * and asks the server to run that path directly. Mutually exclusive
   * with `projectId`.
   */
  projectPath?: string;
  /** Override the `flutter` binary on the remote for ad-hoc projectPath runs. */
  flutterPath?: string;
  flavor?: string;
  flutterArgs: string[];
}

export interface LaunchConfig {
  server?: string;
  device?: string;
  /** Server-side project id (from flutter-projects.json on the remote). */
  projectId?: string;
  /**
   * Absolute path on the remote machine to a Flutter project. Overrides
   * `emulatorStreamRun.projectPath` when set. Mutually exclusive with
   * `projectId`.
   */
  projectPath?: string;
  /** Override the `flutter` binary on the remote for ad-hoc projectPath. */
  flutterPath?: string;
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

  // `projectPath` precedence: launch.json wins, then workspace setting.
  // Empty strings are treated as "unset" so a workspace default of ""
  // doesn't silently override a real launch.json value.
  const projectPath = firstNonEmpty([launchConfig.projectPath, cfg.get<string>('projectPath')]);
  const projectId   = firstNonEmpty([launchConfig.projectId,   cfg.get<string>('projectId')]);
  if (projectId && projectPath) {
    // Same rule as the server: pinning both is meaningless. Prefer
    // the more specific one (projectPath — because it's a filesystem
    // path, not an opaque id — is treated as more specific).
    // We DON'T throw here to keep resolveSettings pure; the
    // orchestrator gets the both-set state, warns, and picks
    // projectPath. See orchestrator.resolveRemoteProject.
  }

  return {
    server: firstNonEmpty([launchConfig.server, cfg.get<string>('server')]) ?? 'ws://127.0.0.1:8080',
    desktopApp: resolveDesktopApp(
      cfg.get<string>('desktopAppPath') ?? '',
      cfg.get<string>('desktopAppRid') ?? '',
      workspaceFolder,
    ),
    desktopAppBaseUrl: (cfg.get<string>('desktopAppBaseUrl') ?? '').trim(),
    desktopAppRid: (cfg.get<string>('desktopAppRid') ?? '').trim(),
    autoUpdateDesktopApp: cfg.get<boolean>('autoUpdateDesktopApp') ?? true,
    openStreamWindow: firstDefined([launchConfig.openStreamWindow, cfg.get<boolean>('openStreamWindow')]) ?? true,
    stopGracePeriodMs: cfg.get<number>('stopGracePeriodMs') ?? 5000,
    device: launchConfig.device?.trim() || undefined,
    projectId,
    projectPath,
    flutterPath: firstNonEmpty([launchConfig.flutterPath, cfg.get<string>('flutterPath')]),
    flavor: firstNonEmpty([launchConfig.flavor, cfg.get<string>('flavor')]),
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

/**
 * Resolution is intentionally strict:
 *
 *   1. `emulatorStreamRun.desktopAppPath` — advanced override, trusted
 *      as-is (no freshness check). Only ever meant for a developer
 *      pointing at a locally-built binary while iterating on the
 *      desktop app itself.
 *   2. `<extension>/vendor/desktop-app/EmulatorDesktopApp[.exe]` —
 *      the canonical path. `.vsix` packaging bakes this into every
 *      installed copy of the extension, so `origin=bundled` is the
 *      only sanctioned state at end-user runtime.
 *
 * No workspace-adjacent fallback anymore. Version mismatches from
 * "someone had a stale `dotnet publish` output on their machine" were
 * the #1 cause of head-scratchers in the two-machine setup, and the
 * whole point of `.vsix` self-containment is to make that impossible.
 */
function resolveDesktopApp(
  setting: string,
  ridOverride: string | undefined,
  workspaceFolder?: vscode.WorkspaceFolder,
): DesktopAppInfo {
  const expanded = setting ? expandVars(setting, workspaceFolder) : '';
  if (expanded) {
    try {
      if (fs.statSync(expanded).isFile()) {
        return buildInfoFor(expanded, 'user-setting');
      }
    } catch { /* fall through — user pointed at a non-existent path */ }
  }
  const found = findBundledDesktopApp({ rid: ridOverride });
  if (found.path) return buildInfoFor(found.path, 'bundled', found.diagnostics);
  return {
    path: undefined,
    origin: 'missing',
    missingFeatures: [],
    diagnostics: found.diagnostics,
  };
}

function buildInfoFor(
  binaryPath: string,
  origin: DesktopAppOrigin,
  diagnostics?: DesktopAppDiagnostics
): DesktopAppInfo {
  const buildInfo = readBuildInfo(binaryPath);
  return {
    path: binaryPath,
    origin,
    mtime: statMtime(binaryPath),
    buildInfo,
    missingFeatures: origin === 'user-setting' ? [] : findMissingFeatures(buildInfo),
    diagnostics,
  };
}

/**
 * Post-install: build a DesktopAppInfo from whatever the installer
 * resolved. Called by the orchestrator (once ensure() returns) and by
 * the doctor command. The `previous` diagnostics are folded in so
 * bundled-layout diagnostics keep bubbling up even after a cache hit
 * decides which binary to run.
 */
export function buildInfoForResolvedSource(
  binaryPath: string,
  origin: DesktopAppOrigin,
  previous?: DesktopAppInfo,
): DesktopAppInfo {
  return buildInfoFor(binaryPath, origin, previous?.diagnostics);
}

/**
 * The pinned desktop-app version this extension expects. Re-exported
 * here so orchestrator / doctor code doesn't need to import the
 * manifest module directly.
 */
export function requiredDesktopAppVersion(): string {
  return PINNED_MANIFEST.requiredVersion;
}

function expandVars(value: string, workspaceFolder?: vscode.WorkspaceFolder): string {
  if (!value) return '';
  return value.replace(/\$\{workspaceFolder\}/g, workspaceFolder?.uri.fsPath ?? process.cwd());
}
