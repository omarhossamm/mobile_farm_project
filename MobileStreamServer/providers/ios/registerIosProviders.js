'use strict';

/**
 * Registers iOS simulator platform providers.
 * @module providers/ios/registerIosProviders
 */

const { SimctlDiscoveryProvider } = require('./discovery/SimctlDiscoveryProvider');
const { SimulatorLifecycleProvider } = require('./lifecycle/SimulatorLifecycleProvider');
const { IdbHidControlProvider } = require('./control/IdbHidControlProvider');
const { CoreSimIOSurfaceProvider } = require('./capture/CoreSimIOSurfaceProvider');
const { IdbTranscodeProvider } = require('./capture/IdbTranscodeProvider');

function registerIosProviders(registry) {
  registry.registerDiscovery(new SimctlDiscoveryProvider());
  registry.registerLifecycle(new SimulatorLifecycleProvider());
  registry.registerControl(new IdbHidControlProvider());
  // Priority order resolved by config/providers.js: coresim → idb-transcode.
  registry.registerCapture(new CoreSimIOSurfaceProvider());
  registry.registerCapture(new IdbTranscodeProvider());
}

module.exports = { registerIosProviders };
