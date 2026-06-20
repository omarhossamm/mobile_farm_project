/**
 * Registers Android platform providers.
 * @module providers/android/registerAndroidProviders
 */

const { AdbDiscoveryProvider } = require('./discovery/AdbDiscoveryProvider');
const { EmulatorLifecycleProvider } = require('./lifecycle/EmulatorLifecycleProvider');
const { AdbInputProvider } = require('./control/AdbInputProvider');
const { AdbScreenrecordCaptureProvider } = require('./capture/AdbScreenrecordCaptureProvider');
const { ScrcpyCaptureProvider } = require('./capture/ScrcpyCaptureProvider');

function registerAndroidProviders(registry) {
  registry.registerDiscovery(new AdbDiscoveryProvider());
  registry.registerLifecycle(new EmulatorLifecycleProvider());
  registry.registerControl(new AdbInputProvider());
  // Register both; priority order is resolved by config/providers.js.
  registry.registerCapture(new ScrcpyCaptureProvider());
  registry.registerCapture(new AdbScreenrecordCaptureProvider());
}

module.exports = { registerAndroidProviders };
