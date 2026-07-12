import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

export const REBUILD_COMMAND = 'emulatorStreamRun.rebuildDesktopApp';

/**
 * Register a Command Palette entry that reruns scripts/bootstrap.js —
 * i.e. `dotnet publish` for the current platform + copy into
 * vendor/desktop-app/ + write BUILD_INFO.json. Used both interactively
 * (from the palette) and as the "Rebuild Desktop App" button on the
 * stale-bundle warning notification.
 *
 * We shell out to `node scripts/bootstrap.js` rather than requiring
 * the file in-process because bootstrap uses execFileSync with
 * `stdio: inherit` and we want its output piped into a proper
 * VS Code Output channel (so the user can see `dotnet publish`
 * progress in real time).
 */
export function registerRebuildCommand(context: vscode.ExtensionContext): void {
  const extensionRoot = path.resolve(__dirname, '..');
  const bootstrapScript = path.join(extensionRoot, 'scripts', 'bootstrap.js');
  const channel = vscode.window.createOutputChannel('Emulator Stream: Rebuild');
  context.subscriptions.push(channel);

  context.subscriptions.push(
    vscode.commands.registerCommand(REBUILD_COMMAND, async () => {
      if (!fs.existsSync(bootstrapScript)) {
        void vscode.window.showErrorMessage(
          `Emulator Stream: cannot find bootstrap script at ${bootstrapScript}. ` +
          `Is the extension folder intact? On a "thin client" install without the ` +
          `EmulatorDesktopApp source next to it, publish the binary on your build ` +
          `machine and copy vendor/desktop-app/ over instead.`
        );
        return;
      }

      channel.clear();
      channel.show(true);
      channel.appendLine(`▸ Running: node ${bootstrapScript}`);
      channel.appendLine(`  extensionRoot = ${extensionRoot}`);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Emulator Stream: rebuilding desktop app…',
          cancellable: false,
        },
        () =>
          new Promise<void>((resolve) => {
            const child = spawn(process.execPath, [bootstrapScript], {
              cwd: extensionRoot,
              env: process.env,
            });
            child.stdout.on('data', (b: Buffer) => channel.append(b.toString('utf8')));
            child.stderr.on('data', (b: Buffer) => channel.append(b.toString('utf8')));
            child.on('error', (err) => {
              channel.appendLine(`\nfailed to start node: ${err.message}`);
              void vscode.window.showErrorMessage(
                `Emulator Stream: failed to spawn Node — ${err.message}`
              );
              resolve();
            });
            child.on('close', (code) => {
              channel.appendLine(`\nbootstrap exit code=${code ?? 'null'}`);
              if (code === 0) {
                void vscode.window.showInformationMessage(
                  'Emulator Stream: desktop app rebuilt. Press F5 to try again.'
                );
              } else {
                void vscode.window.showErrorMessage(
                  `Emulator Stream: rebuild failed (exit ${code ?? 'null'}). See "Emulator Stream: Rebuild" output.`
                );
              }
              resolve();
            });
          })
      );
    })
  );
}
