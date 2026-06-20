/**
 * Aggregates device lists from all registered discovery providers.
 * Produces a unified device list from all registered discovery providers.
 * @module core/catalog/CatalogAggregator
 */

const { createLogger } = require('../../lib/logger');

const logger = createLogger('CATALOG_AGG');

class CatalogAggregator {
  /**
   * @param {import('../../platform/ProviderRegistry').ProviderRegistry} registry
   */
  constructor(registry) {
    this._registry = registry;
  }

  /**
   * Query all discovery providers in parallel and merge results into a
   * flat, client-ready array.
   *
   * @returns {Promise<{success: boolean, devices: Array, avd_list_error?: string, error?: string}>}
   */
  async listForClient() {
    const providers = this._registry.listDiscoveryProviders();
    if (!providers.length) {
      return { success: true, devices: [], avd_list_error: 'No discovery providers registered' };
    }

    const results = await Promise.allSettled(
      providers.map((p) => p.scan().catch((err) => ({ success: false, error: err.message, devices: [] })))
    );

    const merged = [];
    const seen = new Set();
    let avdListError = undefined;
    let fatalError = undefined;

    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn('Discovery provider scan rejected', { reason: result.reason });
        continue;
      }

      const { value } = result;
      if (!value.success) {
        if (value.avd_list_error) avdListError = value.avd_list_error;
        if (value.error) logger.debug('Discovery scan partial error', { error: value.error });
        continue;
      }

      for (const ref of (value.devices || [])) {
        if (!ref.id || seen.has(ref.id)) continue;
        seen.add(ref.id);
        merged.push(this._toClientEntry(ref));
      }
    }

    // Sort: online first, then by name
    merged.sort((a, b) => {
      const ra = a.status === 'online' ? 0 : 1;
      const rb = b.status === 'online' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });

    return { success: true, devices: merged, avd_list_error: avdListError };
  }

  /**
   * Converts an internal DeviceRef to the client wire format.
   * Backward-compatible with the existing Android catalog format.
   */
  _toClientEntry(ref) {
    return {
      device_id: ref.id,
      name: ref.displayName || ref.id,
      status: ref.status || 'offline',
      kind: ref.metadata?.kind || ref.targetClass || 'device',
      avd_name: ref.metadata?.avd_name || (ref.targetClass === 'avd' ? ref.id : null),
      platform: ref.platform || 'android',
      target_class: ref.targetClass || 'device',
      capabilities: ref.capabilities || null
    };
  }
}

module.exports = { CatalogAggregator };
