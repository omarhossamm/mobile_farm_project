/**
 * PlatformHost — in-process facade over ProviderRegistry.
 *
 * @module platform/PlatformHost
 */

const { ProviderRegistry } = require('./ProviderRegistry');
const { registerAndroidProviders } = require('../providers/android/registerAndroidProviders');
const { registerIosProviders } = require('../providers/ios/registerIosProviders');
const { CatalogAggregator } = require('../core/catalog/CatalogAggregator');
const { createLogger } = require('../lib/logger');

const logger = createLogger('PLATFORM_HOST');

class PlatformHost {
  constructor() {
    this.registry = new ProviderRegistry();
    this._bindings = new Map();
    this._catalog = null;
  }

  initialize() {
    registerAndroidProviders(this.registry);
    registerIosProviders(this.registry);
    logger.info('Platform providers registered', { platforms: ['android', 'ios'] });
    this._catalog = new CatalogAggregator(this.registry);
  }

  async listDevices() {
    return this._catalog.listForClient();
  }

  bindSession(sessionId, handle) {
    handle.sessionId = sessionId;

    let controlProvider = null;
    try {
      controlProvider = this.registry.resolveControl(handle);
    } catch (err) {
      logger.warn('No control provider for session', {
        sessionId,
        platform: handle.ref.platform,
        error: err.message
      });
    }

    this._bindings.set(sessionId, { handle, controlProvider });
    logger.info('Session bound to platform host', {
      sessionId,
      platform: handle.ref.platform,
      targetClass: handle.ref.targetClass,
      controlProvider: controlProvider?.providerId || 'none'
    });
  }

  unbindSession(sessionId) {
    const binding = this._bindings.get(sessionId);
    if (binding?.controlProvider?.closeSession) {
      try {
        binding.controlProvider.closeSession(sessionId);
      } catch (err) {
        logger.debug('closeSession threw on unbind', { sessionId, error: err.message });
      }
    }
    this._bindings.delete(sessionId);
  }

  getSessionBinding(sessionId) {
    return this._bindings.get(sessionId) || null;
  }
}

const platformHost = new PlatformHost();
platformHost.initialize();

module.exports = { PlatformHost, platformHost };
