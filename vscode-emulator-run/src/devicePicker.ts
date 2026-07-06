import * as vscode from 'vscode';
import type { DeviceEntry } from './serverClient';

/**
 * Show a Quick Pick to choose a remote device.
 *
 * Rules:
 *   - Zero devices from server → throw with a helpful message.
 *   - Zero *available* (all busy) → throw a clear "all in use" error.
 *   - Exactly one available → auto-select, no picker.
 *   - Multiple available → picker with online-first ordering.
 *
 * In-use devices are hidden from the picker entirely — the user only
 * ever sees devices they can actually run on. The pinned-device path
 * (device id set in launch.json) still checks `in_use` and throws
 * `DeviceInUseError` — see Orchestrator.discoverAndPickDevice.
 */
export async function pickDevice(devices: DeviceEntry[]): Promise<DeviceEntry> {
  if (devices.length === 0) {
    throw new Error(
      'The emulator server did not return any devices. ' +
      'Start an emulator/simulator on the server host and try again.'
    );
  }

  const available = devices.filter((d) => !d.in_use);
  if (available.length === 0) {
    const busy = devices.map((d) => d.name ?? d.avd_name ?? d.device_id).join(', ');
    throw new Error(
      `All returned devices are already in use by another session (${busy}). ` +
      `Close one of the running sessions or start a different emulator/simulator.`
    );
  }
  if (available.length === 1) return available[0];

  const sorted = [...available].sort((a, b) => {
    const aOnline = a.status === 'online' ? 0 : 1;
    const bOnline = b.status === 'online' ? 0 : 1;
    if (aOnline !== bOnline) return aOnline - bOnline;
    const ap = (a.platform ?? '').localeCompare(b.platform ?? '');
    if (ap !== 0) return ap;
    return (a.name ?? a.avd_name ?? a.device_id).localeCompare(b.name ?? b.avd_name ?? b.device_id);
  });

  interface Item extends vscode.QuickPickItem {
    device: DeviceEntry;
  }
  const items: Item[] = sorted.map((d) => {
    const platform = (d.platform ?? '').toLowerCase();
    const iconId = platform === 'ios' ? 'device-mobile' : platform === 'android' ? 'device-desktop' : 'question';
    const name = d.name ?? d.avd_name ?? d.device_id;
    return {
      device: d,
      label: `$(${iconId})  ${name}`,
      description: `${platform || 'unknown'} · ${d.status ?? 'unknown'}`,
      detail: d.device_id,
      picked: d.status === 'online',
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Select a device to run on',
    placeHolder: `${available.length} available (${devices.length - available.length} hidden: already in use)`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) throw new UserCancelled();
  return picked.device;
}

export class UserCancelled extends Error {
  constructor() { super('User cancelled device selection'); this.name = 'UserCancelled'; }
}

/**
 * Thrown when a pinned device (device id set in launch.json) turns out
 * to be already owned by another live session. The picker never
 * produces this — it filters those devices out — but the orchestrator
 * still checks explicitly for the pinned-device path.
 */
export class DeviceInUseError extends Error {
  constructor(public readonly device: DeviceEntry) {
    const name = device.name ?? device.avd_name ?? device.device_id;
    super(
      `Device "${name}" is already in use by another session. ` +
      `Pick a different device or close the other session first.`
    );
    this.name = 'DeviceInUseError';
  }
}
