'use strict';

/**
 * iOS simulator discovery via `xcrun simctl`.
 * @module providers/ios/discovery/SimctlDiscoveryProvider
 */

const simctl = require('../../../lib/simctl');
const { resolveDeviceGeometry } = require('../../../config/iosDeviceSizes');
const { PLATFORMS } = require('../../../platform/types');

class SimctlDiscoveryProvider {
  constructor() {
    this.providerId = 'ios-simctl-discovery';
    this.platform = PLATFORMS.IOS;
  }

  async scan() {
    let devices;
    try {
      devices = await simctl.listDevices();
    } catch (err) {
      return { success: false, devices: [], error: err.message };
    }

    const refs = devices
      // Simulators only (exclude paired watches/tv where sensible — keep iPhone/iPad).
      .filter((d) => /iPhone|iPad/i.test(d.name) || /iOS/i.test(d.runtime))
      .map((d) => {
        const online = d.state === 'Booted';
        const { logical, scale } = resolveDeviceGeometry(d.deviceTypeIdentifier, null);
        return {
          id: d.udid,
          platform: PLATFORMS.IOS,
          targetClass: 'simulator',
          displayName: `${d.name} (${d.runtime})`,
          status: online ? 'online' : 'offline',
          deviceTypeIdentifier: d.deviceTypeIdentifier,
          capabilities: {
            canStream: online,
            canControl: online,
            canLaunchApps: online,
            preferredCaptureProviders: ['ios-coresim-iosurface', 'ios-idb-transcode'],
            preferredControlProviders: ['ios-idb-hid']
          },
          metadata: {
            kind: 'simulator',
            deviceTypeIdentifier: d.deviceTypeIdentifier,
            runtime: d.runtime,
            logical_width: logical.w,
            logical_height: logical.h,
            backing_scale: scale
          }
        };
      });

    return { success: true, devices: refs };
  }
}

module.exports = { SimctlDiscoveryProvider };
