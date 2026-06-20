/**
 * Android device discovery via ADB + emulator AVD list.
 * @module providers/android/discovery/AdbDiscoveryProvider
 */

const adb = require('../../../adb');
const emulator = require('../../../emulator');
const { PLATFORMS } = require('../../../platform/types');

async function resolveAvdNameForDevice(deviceId) {
  if (!deviceId || !deviceId.startsWith('emulator-')) {
    return null;
  }

  const props = [
    'ro.kernel.qemu.avd_name',
    'ro.boot.qemu.avd_name',
    'qemu.avd_name'
  ];

  for (const prop of props) {
    const result = await adb.deviceCommand(deviceId, `shell getprop ${prop}`);
    if (result.success) {
      const value = (result.output || '').trim();
      if (value) {
        return value;
      }
    }
  }

  return null;
}

function inferTargetClass(deviceId, kind) {
  if (kind === 'avd') return 'avd';
  if (deviceId.includes(':')) return 'physical';
  return 'emulator';
}

class AdbDiscoveryProvider {
  constructor() {
    this.providerId = 'adb-discovery';
    this.platform = PLATFORMS.ANDROID;
  }

  async scan() {
    const [devicesResult, avdsResult] = await Promise.all([
      adb.getDevices(),
      emulator.listAvailableEmulators()
    ]);

    if (!devicesResult.success) {
      return { success: false, devices: [], error: devicesResult.error };
    }

    const refs = [];
    const onlineAvdNames = new Set();

    for (const device of devicesResult.devices) {
      let avdName = null;

      if (device.status === 'online' && device.device_id.startsWith('emulator-')) {
        avdName = await resolveAvdNameForDevice(device.device_id);
        if (avdName) {
          onlineAvdNames.add(avdName);
        }
      }

      const kind = device.device_id.includes(':') ? 'physical' : 'emulator';

      refs.push({
        id: device.device_id,
        platform: PLATFORMS.ANDROID,
        targetClass: inferTargetClass(device.device_id, kind),
        displayName: device.device_id,
        status: device.status,
        capabilities: {
          canStream: device.status === 'online',
          canControl: device.status === 'online',
          canLaunchApps: device.status === 'online',
          preferredCaptureProviders: ['scrcpy-capture', 'adb-screenrecord'],
          preferredControlProviders: ['adb-input']
        },
        metadata: {
          avd_name: avdName || '',
          kind
        }
      });
    }

    const avds = avdsResult.success ? avdsResult.avds : [];

    for (const avd of avds) {
      if (onlineAvdNames.has(avd)) continue;

      const listedOnline = refs.some((e) => e.id === avd && e.status === 'online');
      if (listedOnline) continue;

      refs.push({
        id: avd,
        platform: PLATFORMS.ANDROID,
        targetClass: 'avd',
        displayName: avd,
        status: 'offline',
        capabilities: {
          canStream: true,
          canControl: true,
          canLaunchApps: true,
          preferredCaptureProviders: ['scrcpy-capture', 'adb-screenrecord'],
          preferredControlProviders: ['adb-input']
        },
        metadata: { avd_name: avd, kind: 'avd' }
      });
    }

    refs.sort((a, b) => {
      const ra = a.status === 'online' ? 0 : 1;
      const rb = b.status === 'online' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return a.displayName.localeCompare(b.displayName);
    });

    return {
      success: true,
      devices: refs,
      avd_list_error: avdsResult.success ? undefined : avdsResult.error
    };
  }
}

module.exports = { AdbDiscoveryProvider, resolveAvdNameForDevice };
