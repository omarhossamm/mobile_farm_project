/**
 * Builds a unified device catalog: all ADB entries (any status) + offline AVDs.
 */

const adb = require('./adb');
const emulator = require('./emulator');

/**
 * Resolve AVD name for a running emulator device id (online only).
 * @param {string} deviceId
 * @returns {Promise<string|null>}
 */
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

/**
 * @returns {Promise<{success: boolean, devices: Array<object>, error?: string}>}
 */
async function buildDeviceCatalog() {
  const [devicesResult, avdsResult] = await Promise.all([
    adb.getDevices(),
    emulator.listAvailableEmulators()
  ]);

  if (!devicesResult.success) {
    return { success: false, devices: [], error: devicesResult.error };
  }

  const entries = [];
  const onlineAvdNames = new Set();

  for (const device of devicesResult.devices) {
    let avdName = null;

    if (device.status === 'online' && device.device_id.startsWith('emulator-')) {
      avdName = await resolveAvdNameForDevice(device.device_id);
      if (avdName) {
        onlineAvdNames.add(avdName);
      }
    }

    entries.push({
      device_id: device.device_id,
      name: device.device_id,
      status: device.status,
      kind: device.device_id.includes(':') ? 'physical' : 'emulator',
      avd_name: avdName
    });
  }

  const avds = avdsResult.success ? avdsResult.avds : [];

  for (const avd of avds) {
    if (onlineAvdNames.has(avd)) {
      continue;
    }

    const listedOnline = entries.some(
      (entry) => entry.device_id === avd && entry.status === 'online'
    );
    if (listedOnline) {
      continue;
    }

    entries.push({
      device_id: avd,
      name: avd,
      status: 'offline',
      kind: 'avd',
      avd_name: avd
    });
  }

  entries.sort((a, b) => {
    const rank = (status) => (status === 'online' ? 0 : 1);
    const byRank = rank(a.status) - rank(b.status);
    if (byRank !== 0) {
      return byRank;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    success: true,
    devices: entries,
    avd_list_error: avdsResult.success ? undefined : avdsResult.error
  };
}

module.exports = {
  buildDeviceCatalog,
  resolveAvdNameForDevice
};
