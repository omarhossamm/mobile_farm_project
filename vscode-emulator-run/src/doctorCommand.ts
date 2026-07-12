import * as vscode from 'vscode';
import { resolveSettings } from './settings';
import { formatDiagnosticsReport, formatBuildInfoLine, isStale, stalenessReason } from './desktopAppFreshness';

export const DOCTOR_COMMAND = 'emulatorStreamRun.doctor';

/**
 * `Emulator Stream: Diagnose Desktop App`.
 *
 * Every .vsix is platform-specific, so the doctor's job is narrow:
 *
 *   • Print WHERE the extension looked for the bundled binary.
 *   • Print WHAT it found (or why it didn't).
 *   • Print BUILD_INFO for the resolved binary so users can eyeball
 *     the git sha / feature set.
 *
 * There is no cache, no download log, no update check to report.
 */
export function registerDoctorCommand(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Emulator Stream: Doctor');
  context.subscriptions.push(channel);

  context.subscriptions.push(
    vscode.commands.registerCommand(DOCTOR_COMMAND, () => runDoctor(context, channel))
  );
}

async function runDoctor(_context: vscode.ExtensionContext, channel: vscode.OutputChannel): Promise<void> {
  const settings = resolveSettings({}, vscode.workspace.workspaceFolders?.[0]);
  const info = settings.desktopApp;

  channel.clear();
  channel.appendLine(`Emulator Stream — desktop app diagnosis @ ${new Date().toISOString()}`);
  channel.appendLine('');
  channel.appendLine('── Effective settings ──────────────────────────');
  channel.appendLine(`Server:                        ${settings.server}`);
  channel.appendLine(`desktopAppPath (override):     ${info.origin === 'user-setting' ? info.path : '(unset)'}`);
  channel.appendLine('');
  channel.appendLine('── Bundle resolution ───────────────────────────');
  channel.appendLine(formatDiagnosticsReport(info));

  if (info.path) {
    channel.appendLine('');
    channel.appendLine('── Resolved binary ─────────────────────────────');
    channel.appendLine(`Path:       ${info.path}`);
    channel.appendLine(`Build info: ${formatBuildInfoLine(info)}`);
    const stale = stalenessReason(info);
    if (isStale(info) && stale) {
      channel.appendLine(`Warning:    ${stale}`);
    }
    channel.show(true);
    void vscode.window.showInformationMessage(
      `Emulator Stream: desktop app OK via ${info.origin}. See the "Emulator Stream: Doctor" output for details.`
    );
    return;
  }

  channel.show(true);
  const pick = await vscode.window.showErrorMessage(
    `Emulator Stream: bundled desktop app is missing on this host. See the "Emulator Stream: Doctor" output for the exact remediation.`,
    'Open Output',
  );
  if (pick === 'Open Output') channel.show(true);
}
