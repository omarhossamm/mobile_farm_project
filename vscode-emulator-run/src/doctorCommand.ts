import * as vscode from 'vscode';
import { resolveSettings, requiredDesktopAppVersion, buildInfoForResolvedSource } from './settings';
import { formatDiagnosticsReport, stalenessReason } from './desktopAppFreshness';
import { getDesktopAppInstaller } from './extension';
import { InstallerError, type ResolvedSource, type ProgressReporter } from './desktopAppInstaller';
import { PINNED_MANIFEST } from './desktopAppManifest';

export const DOCTOR_COMMAND = 'emulatorStreamRun.doctor';
export const REDOWNLOAD_COMMAND = 'emulatorStreamRun.redownloadDesktopApp';

/**
 * `Emulator Stream: Diagnose Desktop App`.
 *
 * With the download-on-first-run distribution model, this command
 * serves three audiences:
 *
 *   • **End users** hitting "stream window won't open" — quick
 *     visibility into whether the binary was downloaded, which
 *     version is cached, and where the archive was fetched from.
 *   • **Support** dumping a copy-pasteable snapshot of everything
 *     the extension knows about the binary resolution ladder.
 *   • **Maintainers** verifying the pinned manifest matches what a
 *     real `.vsix` install resolves to at runtime.
 *
 * The companion `emulatorStreamRun.redownloadDesktopApp` command
 * purges the cache and re-triggers the installer. Useful when a
 * user suspects a corrupt download or wants to move to a newer
 * cached version manually.
 */
export function registerDoctorCommand(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Emulator Stream: Doctor');
  context.subscriptions.push(channel);

  context.subscriptions.push(
    vscode.commands.registerCommand(DOCTOR_COMMAND, () => runDoctor(context, channel))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(REDOWNLOAD_COMMAND, () => forceRedownload(context, channel))
  );
}

async function runDoctor(context: vscode.ExtensionContext, channel: vscode.OutputChannel): Promise<void> {
  const settings = resolveSettings({}, vscode.workspace.workspaceFolders?.[0]);
  const info = settings.desktopApp;

  channel.clear();
  channel.appendLine(`Emulator Stream — desktop app diagnosis @ ${new Date().toISOString()}`);
  channel.appendLine('');
  channel.appendLine('── Pinned manifest ─────────────────────────────');
  channel.appendLine(`Required version:  ${requiredDesktopAppVersion()}`);
  channel.appendLine(`Manifest baseUrl:  ${PINNED_MANIFEST.defaultBaseUrl || '(unset — publish script has not run)'}`);
  channel.appendLine(`Update manifest:   ${PINNED_MANIFEST.updateManifestUrl || '(disabled)'}`);
  channel.appendLine(`Published assets:  ${Object.keys(PINNED_MANIFEST.assets).sort().join(', ') || '(none)'}`);
  channel.appendLine('');
  channel.appendLine('── Effective settings ──────────────────────────');
  channel.appendLine(`Server:                        ${settings.server}`);
  channel.appendLine(`desktopAppPath (override):     ${info.origin === 'user-setting' ? info.path : '(unset)'}`);
  channel.appendLine(`desktopAppRid  (override):     ${settings.desktopAppRid || '(auto)'}`);
  channel.appendLine(`desktopAppBaseUrl (override):  ${settings.desktopAppBaseUrl || '(pinned default)'}`);
  channel.appendLine(`autoUpdateDesktopApp:          ${settings.autoUpdateDesktopApp}`);
  channel.appendLine('');
  channel.appendLine('── Preliminary bundle resolution ───────────────');
  channel.appendLine(formatDiagnosticsReport(info));

  // Installer state (cache) — usable even without hitting the
  // network. This is the "what would F5 use right now?" summary.
  let installer;
  try { installer = getDesktopAppInstaller(); } catch { installer = null; }

  if (installer) {
    const state = installer.state(context.globalStorageUri.fsPath);
    channel.appendLine('');
    channel.appendLine('── Installer cache ─────────────────────────────');
    channel.appendLine(`Cache root:                    ${state.cacheDir}`);
    if (state.cachedVersions.length === 0) {
      channel.appendLine('Cached versions:               (empty)');
    } else {
      channel.appendLine('Cached versions:');
      for (const c of state.cachedVersions) {
        channel.appendLine(`  • v${c.version} · ${c.rid} · installed ${c.okAt ?? '(no .ok sentinel — incomplete)'}`);
      }
    }
    channel.appendLine(`Last update check at:          ${state.lastUpdateCheckAt ?? '(never)'}`);
    channel.appendLine(`Last update check result:      ${state.lastUpdateCheckResult ?? '(never)'}`);
    if (state.lastDownloadError) {
      channel.appendLine(`Last download error:           ${state.lastDownloadError}`);
    }
  } else {
    channel.appendLine('');
    channel.appendLine('── Installer cache ─────────────────────────────');
    channel.appendLine('(installer not initialised — extension activate() has not run yet)');
  }

  // Dry-run resolution — pretend we're about to spawn.
  channel.appendLine('');
  channel.appendLine('── Resolution attempt ──────────────────────────');
  if (!installer) {
    channel.appendLine('SKIPPED: installer unavailable.');
    channel.show(true);
    return;
  }
  try {
    const reporter: ProgressReporter = (p) => {
      if (p.message) channel.appendLine(`  [${p.phase}] ${p.message}`);
    };
    const resolved: ResolvedSource = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Emulator Stream: doctor — resolving desktop app…',
      cancellable: true,
    }, async (_progress, token) => installer.ensure({
      extensionRoot: context.extensionUri.fsPath,
      cacheRoot: context.globalStorageUri.fsPath,
      rid: settings.desktopAppRid || undefined,
      userPath: info.origin === 'user-setting' ? info.path : undefined,
      baseUrlOverride: settings.desktopAppBaseUrl || undefined,
      progress: reporter,
      cancel: token,
    }));
    const resolvedInfo = buildInfoForResolvedSource(resolved.path, resolved.kind, info);
    channel.appendLine(`RESULT: ✓ ${resolved.kind} → ${resolved.path}`);
    if ('version' in resolved) channel.appendLine(`Version: ${resolved.version}`);
    if ('rid' in resolved) channel.appendLine(`RID:     ${resolved.rid}`);
    channel.appendLine(`Build info: ${JSON.stringify(resolvedInfo.buildInfo ?? null)}`);
    const stale = stalenessReason(resolvedInfo);
    if (stale) channel.appendLine(`Warning: ${stale}`);
    channel.show(true);
    void vscode.window.showInformationMessage(
      `Emulator Stream: desktop app OK via ${resolved.kind}. See the "Emulator Stream: Doctor" output for details.`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof InstallerError ? err.code : 'unknown';
    channel.appendLine(`RESULT: ✖ ${message}  (code=${code})`);
    channel.appendLine('');
    channel.appendLine('Remediation ideas:');
    channel.appendLine('  • Set `emulatorStreamRun.desktopAppBaseUrl` to your release server if the pinned default is empty.');
    channel.appendLine('  • Point `emulatorStreamRun.desktopAppPath` at a manually-downloaded binary.');
    channel.appendLine('  • Run `Emulator Stream: Redownload Desktop App` (clears the cache and retries).');
    channel.appendLine('  • Install the `--bundle` (fat) .vsix if this machine is air-gapped.');
    channel.show(true);
    const pick = await vscode.window.showErrorMessage(
      `Emulator Stream: desktop app resolution failed (${code}). See the "Emulator Stream: Doctor" output for details.`,
      'Open Output',
      'Redownload',
    );
    if (pick === 'Open Output') channel.show(true);
    else if (pick === 'Redownload') void vscode.commands.executeCommand(REDOWNLOAD_COMMAND);
  }
}

async function forceRedownload(context: vscode.ExtensionContext, channel: vscode.OutputChannel): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    'Emulator Stream: purge the desktop-app cache and re-download on next launch?',
    { modal: true },
    'Purge',
    'Cancel',
  );
  if (confirm !== 'Purge') return;

  const installer = getDesktopAppInstaller();
  installer.purgeCache(context.globalStorageUri.fsPath);
  channel.appendLine(`[${new Date().toISOString()}] cache purged at user request.`);
  channel.show(true);
  void vscode.window.showInformationMessage(
    'Emulator Stream: cache purged. The next launch will re-download the desktop app.',
    'Run Doctor',
  ).then((choice) => {
    if (choice === 'Run Doctor') void vscode.commands.executeCommand(DOCTOR_COMMAND);
  });
}
