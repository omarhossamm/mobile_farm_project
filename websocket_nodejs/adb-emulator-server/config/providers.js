/**
 * Provider priority lists — used by ProviderRegistry when resolving implementations.
 */

module.exports = {
  capture: {
    android: ['scrcpy-capture', 'adb-screenrecord'],
    // iOS simulators: CoreSimulator framebuffer (IOSurface → VideoToolbox) is
    // primary; policy-free idb→baseline transcode is the only fallback tier.
    ios: ['ios-coresim-iosurface', 'ios-idb-transcode']
  },
  control: {
    android: ['adb-input'],
    ios: ['ios-idb-hid']
  },
  discovery: {
    android: ['adb-discovery'],
    ios: ['ios-simctl-discovery']
  },
  lifecycle: {
    android: ['android-emulator-lifecycle'],
    ios: ['ios-simctl-lifecycle']
  }
};

/**
 * Resolve capture provider priority list from a device handle.
 * @param {import('../platform/types').DeviceHandle} handle
 * @returns {string[]}
 */
function getCapturePriorityList(handle) {
  const platform = handle?.ref?.platform;
  if (!platform) return [];
  return module.exports.capture[platform] || [];
}

module.exports.getCapturePriorityList = getCapturePriorityList;
