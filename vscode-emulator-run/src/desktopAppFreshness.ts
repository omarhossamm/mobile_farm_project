import * as fs from 'fs';
import * as path from 'path';

/**
 * Every feature name here must also appear in
 * `REQUIRED_DESKTOP_APP_FEATURES` in scripts/bootstrap.js. When the
 * extension needs a newer contract from the desktop app (new CLI arg,
 * new headless behaviour, new WS message type it must handle), bump
 * BOTH lists — that's what triggers the "your bundled binary is
 * stale, rebuild it" prompt on the next F5.
 *
 * The name is arbitrary; the invariant is only that bootstrap.js
 * writes the tag into BUILD_INFO.json and the extension asserts on it.
 */
export const REQUIRED_DESKTOP_APP_FEATURES = ['headless-attach-v1'] as const;

export type DesktopAppOrigin =
  | 'user-setting'    // user pointed at a specific binary via emulatorStreamRun.desktopAppPath
  | 'bundled'         // ../vendor/desktop-app/ — baked into the .vsix at package time (dev-mode or --bundle vsix)
  | 'cached'          // installer's global-storage cache — extracted from a previously-downloaded archive
  | 'downloaded'      // just fetched over the network in this session
  | 'missing';        // nothing found and no way to get it — extension is malformed / no-network

export interface BuildInfo {
  builtAt?: string;
  rid?: string;
  gitSha?: string | null;
  features?: string[];
  nodeVersion?: string;
  platform?: string;
}

/**
 * Raw facts about the last bundle-lookup attempt. Attached to
 * DesktopAppInfo so callers turning `origin === 'missing'` into a user
 * message can quote the exact paths probed + everything actually
 * present next door — without which the resulting error is useless
 * for anyone debugging remotely.
 */
export interface DesktopAppDiagnostics {
  /** e.g. "win32/x64", "darwin/arm64" — the host running the extension. */
  extensionPlatform: string;
  /**
   * The .NET RID we're looking for. Normally derived from
   * process.platform/arch; may be overridden by the user setting
   * `emulatorStreamRun.desktopAppRid` for edge cases (Rosetta 2,
   * cross-arch containers, …).
   */
  hostRid: string;
  /**
   * User-supplied RID override if any. Present so the doctor
   * output can flag "you're forcing osx-x64, is that intentional?".
   */
  ridOverride?: string;
  /** e.g. "EmulatorDesktopApp.exe" or "EmulatorDesktopApp". */
  expectedBinaryName: string;
  /** Every path we tried, in the order tried. */
  probedPaths: string[];
  /** Absolute path of vendor/desktop-app/. */
  vendorDir: string;
  /** True iff vendorDir exists and is a directory. */
  vendorExists: boolean;
  /**
   * Sorted `fs.readdir` of the vendor dir (top-level only). Missing
   * when vendorExists is false. In the multi-platform layout this
   * includes the RID subdirs; in the legacy flat layout it's the
   * runtime files themselves.
   */
  vendorContents?: string[];
  /** `vendor/desktop-app/<hostRid>/` — where we EXPECTED to find the binary. */
  ridSubdir: string;
  /** True iff that subdirectory exists on disk. */
  ridSubdirExists: boolean;
  /** Sorted `fs.readdir` of the RID subdir. Missing when ridSubdirExists=false. */
  ridSubdirContents?: string[];
  /**
   * RIDs for which the bundle ships a working binary. Empty in
   * legacy (flat) layout — that layout is single-platform by
   * definition.
   */
  availableRids: string[];
  /**
   * True when the resolution succeeded via the legacy flat layout,
   * i.e. the multi-platform per-RID subdir wasn't there but the
   * top-level EmulatorDesktopApp[.exe] was. Kept for observability;
   * a warning is emitted upstream so users know to rebuild.
   */
  legacyFallbackUsed?: boolean;
  /**
   * Populated when we can prove the bundle inside the .vsix was
   * produced for the wrong platform.
   *
   * Two sources of truth:
   *   - Multi-platform bundle missing the host's RID subdir → the
   *     "installedFor" field lists the RIDs that ARE present.
   *   - Legacy flat bundle whose BUILD_INFO.json (or filename shape)
   *     disagrees with the host.
   */
  likelyWrongPlatform?: {
    installedRid?: string;
    installedFor?: string;
    note?: string;
  };
}

export interface DesktopAppInfo {
  path: string | undefined;
  origin: DesktopAppOrigin;
  mtime?: Date;
  buildInfo?: BuildInfo;
  /** Feature names required by this extension but missing from the binary's BUILD_INFO.json. */
  missingFeatures: string[];
  /**
   * Present iff resolution went through the bundled-lookup path. Kept
   * even on success so `emulatorStreamRun.doctor` can print the same
   * info without re-running the probe.
   */
  diagnostics?: DesktopAppDiagnostics;
}

/**
 * Best-effort read of BUILD_INFO.json next to the binary. bootstrap.js
 * writes this file after `dotnet publish`; if it's missing the bundle
 * was NOT produced by our build script (hand-built, ancient checkout,
 * copied from another machine, etc.) and we can't trust its behaviour.
 */
export function readBuildInfo(binaryPath: string): BuildInfo | undefined {
  const dir = path.dirname(binaryPath);
  const candidate = path.join(dir, 'BUILD_INFO.json');
  try {
    const raw = fs.readFileSync(candidate, 'utf8');
    return JSON.parse(raw) as BuildInfo;
  } catch {
    return undefined;
  }
}

export function statMtime(p: string): Date | undefined {
  try { return fs.statSync(p).mtime; } catch { return undefined; }
}

/**
 * Names of features we require but the binary doesn't advertise. Empty
 * array means we're happy with this binary.
 */
export function findMissingFeatures(info: BuildInfo | undefined): string[] {
  const advertised = new Set(info?.features ?? []);
  return REQUIRED_DESKTOP_APP_FEATURES.filter((f) => !advertised.has(f));
}

/**
 * Human-readable summary suitable for printing in the debug console.
 * We include mtime + git sha + features so the user can eyeball whether
 * the running binary matches the source they're editing.
 */
export function formatBuildInfoLine(info: DesktopAppInfo): string {
  const parts: string[] = [];
  parts.push(`origin=${info.origin}`);
  if (info.mtime) parts.push(`built=${info.mtime.toISOString()}`);
  const bi = info.buildInfo;
  if (bi?.gitSha) parts.push(`git=${bi.gitSha}`);
  if (bi?.rid) parts.push(`rid=${bi.rid}`);
  if (bi?.features?.length) parts.push(`features=[${bi.features.join(',')}]`);
  else if (info.origin === 'bundled') parts.push('features=<no BUILD_INFO.json>');
  if (info.missingFeatures.length > 0) parts.push(`missing=[${info.missingFeatures.join(',')}]`);
  return parts.join(' · ');
}

/**
 * True when the resolved binary doesn't meet our contract:
 *   - no binary at all (extension is malformed / half-installed), OR
 *   - bundled path but BUILD_INFO.json is missing / advertises fewer
 *     features than we need.
 *
 * A user-setting path is trusted — the user explicitly opted in, so
 * we don't second-guess them beyond logging what we found.
 */
export function isStale(info: DesktopAppInfo): boolean {
  if (info.origin === 'missing') return true;
  // For every path that involves an on-disk BUILD_INFO.json (i.e. any
  // origin except the trust-me user-setting override), missing
  // features means the binary doesn't advertise the contract this
  // extension needs.
  if (info.origin !== 'user-setting' && info.missingFeatures.length > 0) return true;
  return false;
}

export function stalenessReason(info: DesktopAppInfo): string {
  switch (info.origin) {
    case 'missing':
      return missingReason(info);
    case 'bundled':
      if (info.missingFeatures.length > 0) {
        return `The bundled EmulatorDesktopApp binary was built without the following required feature(s): ${info.missingFeatures.join(', ')}. Install the newer version of the extension (.vsix) that includes the matching desktop app.`;
      }
      return '';
    case 'cached':
    case 'downloaded':
      if (info.missingFeatures.length > 0) {
        return `The downloaded EmulatorDesktopApp is missing required feature(s): ${info.missingFeatures.join(', ')}. Run "Emulator Stream: Redownload Desktop App" to fetch a fresh copy, or update the pinned manifest.`;
      }
      return '';
    case 'user-setting':
      return '';
  }
}

/**
 * Build a message that actually helps someone hitting the "missing"
 * case. The multi-platform bundle collapses most of the old
 * failure modes into a single message ("your host RID isn't shipped
 * in this vsix"), but we still keep the legacy sub-states.
 *
 * Sub-states, in order of probability:
 *
 *  1) vendor/desktop-app/ doesn't exist at all — the .vsix was
 *     packaged without the desktop app bundle at all.
 *  2) Multi-platform bundle without the host RID — bundle has some
 *     RIDs, but not this one. Message shows the list of RIDs that ARE
 *     present.
 *  3) Legacy flat bundle for the wrong platform — pre-multi-platform
 *     vsix installed on the wrong host.
 *  4) Host RID subdir exists but the binary is missing/renamed inside
 *     it — rare, indicates a corrupt install.
 */
function missingReason(info: DesktopAppInfo): string {
  const d = info.diagnostics;
  if (!d) {
    return 'The bundled EmulatorDesktopApp binary is missing from this extension install.';
  }

  const header =
    `The bundled EmulatorDesktopApp binary is missing on this machine ` +
    `(${d.extensionPlatform}, RID=${d.hostRid}). ` +
    `Extension expected: ${d.expectedBinaryName} inside ${d.ridSubdir}.`;

  // Case 1 — vendor dir absent.
  //
  // With the download-on-first-run distribution this is the EXPECTED
  // state before the installer runs. The message points at the network
  // path (which handles it) rather than at rebuilding the .vsix.
  if (!d.vendorExists) {
    return (
      `${header} No bundled binary in the extension (slim vsix). ` +
      `The installer will download it on first launch from the pinned URL, ` +
      `unless the manifest has not been published yet — see the ` +
      `"Emulator Stream: Doctor" command output for the download URL and ` +
      `\`emulatorStreamRun.desktopAppBaseUrl\` setting.`
    );
  }

  // Case 2 — multi-platform bundle, but host RID absent.
  if (d.availableRids.length > 0 && !d.availableRids.includes(d.hostRid)) {
    const ridList = d.availableRids.join(', ');
    const overrideHint = d.ridOverride
      ? ` (you have emulatorStreamRun.desktopAppRid="${d.ridOverride}"; clear that setting to auto-detect)`
      : '';
    return (
      `${header} The bundle ships EmulatorDesktopApp for [${ridList}] ` +
      `but NOT for ${d.hostRid}${overrideHint}. ` +
      `Rebuild the .vsix on a machine that can cross-compile for ` +
      `${d.hostRid} (\`npm run package\` with ${d.hostRid} in the ` +
      `PLATFORM_RIDS list) and reinstall.`
    );
  }

  // Case 3 — legacy flat bundle for the wrong platform.
  if (d.likelyWrongPlatform && d.availableRids.length === 0) {
    const forBits = d.likelyWrongPlatform.installedFor
      ? ` (looks like a build for ${d.likelyWrongPlatform.installedFor}`
        + (d.likelyWrongPlatform.installedRid ? ` — rid=${d.likelyWrongPlatform.installedRid}` : '')
        + ')'
      : '';
    return (
      `${header} vendor/desktop-app/ contains a single-platform (legacy) ` +
      `bundle for a different host${forBits}. Rebuild with \`npm run package\` — ` +
      `the new bundle ships every supported platform in one .vsix.`
    );
  }

  // Case 4 — host RID subdir exists but the binary is missing.
  if (d.ridSubdirExists) {
    const contentsPreview = (d.ridSubdirContents ?? []).slice(0, 20).join(', ');
    return (
      `${header} The RID subdirectory exists but ${d.expectedBinaryName} ` +
      `is not inside it. Files present: [${contentsPreview}` +
      `${(d.ridSubdirContents?.length ?? 0) > 20 ? ', …' : ''}]. ` +
      `The install is corrupt — uninstall and reinstall the .vsix.`
    );
  }

  // Catch-all — vendor dir present but neither layout matches. Show
  // what IS at the vendor root so the user can spot the mismatch.
  const rootPreview = (d.vendorContents ?? []).slice(0, 20).join(', ');
  return (
    `${header} vendor/desktop-app/ contents: [${rootPreview}` +
    `${(d.vendorContents?.length ?? 0) > 20 ? ', …' : ''}]. ` +
    `Neither the per-RID subdir nor the legacy flat layout is usable. ` +
    `Rebuild with \`npm run package\` and reinstall.`
  );
}

/**
 * Multi-line dump suitable for the doctor command / debug console.
 * Includes everything a support ticket would ask for.
 */
export function formatDiagnosticsReport(info: DesktopAppInfo): string {
  const d = info.diagnostics;
  const lines: string[] = [];
  lines.push('EmulatorDesktopApp lookup diagnostics');
  lines.push('─────────────────────────────────────');
  lines.push(`resolvedPath       : ${info.path ?? '(none)'}`);
  lines.push(`origin             : ${info.origin}`);
  lines.push(`mtime              : ${info.mtime?.toISOString() ?? '(n/a)'}`);
  if (info.buildInfo) {
    lines.push(`buildInfo          : ${JSON.stringify(info.buildInfo)}`);
  }
  if (info.missingFeatures.length > 0) {
    lines.push(`missingFeatures    : ${info.missingFeatures.join(', ')}`);
  }
  if (d) {
    lines.push(`host               : ${d.extensionPlatform}`);
    lines.push(`hostRid            : ${d.hostRid}${d.ridOverride ? ' (user override)' : ''}`);
    lines.push(`expectedBinaryName : ${d.expectedBinaryName}`);
    lines.push(`vendorDir          : ${d.vendorDir}`);
    lines.push(`vendorExists       : ${d.vendorExists}`);
    if (d.vendorContents !== undefined) {
      lines.push(`vendorContents     : [${d.vendorContents.join(', ')}]`);
    }
    lines.push(`ridSubdir          : ${d.ridSubdir}`);
    lines.push(`ridSubdirExists    : ${d.ridSubdirExists}`);
    if (d.ridSubdirContents !== undefined) {
      lines.push(`ridSubdirContents  : [${d.ridSubdirContents.join(', ')}]`);
    }
    lines.push(`availableRids      : [${d.availableRids.join(', ')}]`);
    if (d.legacyFallbackUsed) {
      lines.push(`layoutMode         : LEGACY FLAT (rebuild the .vsix with npm run package for the multi-platform layout)`);
    } else {
      lines.push(`layoutMode         : per-RID subdir`);
    }
    lines.push(`probedPaths        :`);
    for (const p of d.probedPaths) lines.push(`  · ${p}`);
    if (d.likelyWrongPlatform) {
      lines.push(`likelyWrongPlatform: ${JSON.stringify(d.likelyWrongPlatform)}`);
    }
  }
  if (info.origin === 'missing') {
    lines.push('');
    lines.push('→ ' + stalenessReason(info));
  }
  return lines.join('\n');
}
