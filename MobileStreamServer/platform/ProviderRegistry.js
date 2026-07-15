/**
 * Registry for pluggable platform providers (discovery, lifecycle, capture, control).
 * @module platform/ProviderRegistry
 */

const providerConfig = require('../config/providers');
const { getCapturePriorityList } = require('../config/providers');
const { createLogger } = require('../lib/logger');

const logger = createLogger('PROVIDER_REG');

class ProviderRegistry {
  constructor() {
    this._discovery = new Map();
    this._lifecycle = new Map();
    this._capture = new Map();
    this._control = new Map();
    this._appLifecycle = new Map();
  }

  registerDiscovery(provider) {
    this._discovery.set(provider.providerId, provider);
  }

  registerLifecycle(provider) {
    this._lifecycle.set(provider.providerId, provider);
  }

  registerCapture(provider) {
    this._capture.set(provider.providerId, provider);
  }

  /**
   * Return a registered capture provider by its exact providerId, or null.
   * Used by hot-swap logic that needs a specific fallback provider without
   * re-running the full parallel probe sequence.
   *
   * @param {string} id  e.g. 'scrcpy-capture'
   * @returns {ICaptureProvider|null}
   */
  getCaptureProvider(id) {
    return this._capture.get(id) ?? null;
  }

  registerControl(provider) {
    this._control.set(provider.providerId, provider);
  }

  registerAppLifecycle(provider) {
    this._appLifecycle.set(provider.providerId, provider);
  }

  listDiscoveryProviders() {
    return [...this._discovery.values()];
  }

  /**
   * Resolves the best available capture provider for the given handle.
   *
   * All provider probes run in parallel (Promise.allSettled) to eliminate the
   * sequential startup latency that accumulated when several probes each had
   * their own timeout (the old sequential code waited up to the sum of all
   * timeouts before reaching a working provider).  After all probes settle,
   * the highest-priority passing provider is selected.
   *
   * The strict permission policy (permissionDenied → throw immediately without
   * falling through) is preserved: if any probe returns permissionDenied=true
   * the error is thrown after all probes complete, even if another provider
   * would have worked.
   *
   * @param {import('./types').DeviceHandle} handle
   * @returns {Promise<ICaptureProvider>}
   */
  async resolveCapture(handle) {
    const { passing, permDeniedErr, failed } = await this._resolveCaptureCandidates(handle);
    if (permDeniedErr) throw permDeniedErr;
    if (passing.length) return passing[0];
    throw new Error(this._formatCaptureFailure(handle, failed));
  }

  /**
   * Like resolveCapture, but returns ALL passing providers in priority order so
   * a CaptureSupervisor can attempt startup failover (primary → fallback).
   *
   * @param {import('./types').DeviceHandle} handle
   * @returns {Promise<ICaptureProvider[]>}
   */
  async resolveCaptureChain(handle) {
    const { passing, permDeniedErr } = await this._resolveCaptureCandidates(handle);
    if (permDeniedErr) throw permDeniedErr;
    return passing;
  }

  /**
   * Run all candidate probes in parallel and classify them.
   * @returns {Promise<{passing: ICaptureProvider[], permDeniedErr: Error|null, failed: object[]}>}
   */
  async _resolveCaptureCandidates(handle) {
    const priority = getCapturePriorityList(handle);
    const candidates = this._orderedCandidates(this._capture, priority, true)
      .filter((p) => !p.supportedTargets ||
        p.supportedTargets.includes(handle.ref.targetClass) ||
        (handle.ref.targetClass === 'avd' && p.supportedTargets.includes('emulator')))
      .filter((p) => typeof p.supports !== 'function' || p.supports(handle));

    if (candidates.length === 0) {
      throw new Error(this._formatCaptureFailure(handle, []));
    }

    const probeStart = Date.now();

    // Fire all probes simultaneously — the total wait equals the slowest single
    // probe rather than the sum of all probes.
    const settled = await Promise.allSettled(
      candidates.map((p) => p.probe(handle.ref))
    );

    const probeMs = Date.now() - probeStart;

    // Walk candidates in priority order and classify each result.
    const attempts = [];
    const passing = [];
    let permDeniedErr = null;

    for (let i = 0; i < candidates.length; i++) {
      const provider = candidates[i];
      const r = settled[i];

      if (r.status === 'rejected') {
        const err = r.reason;
        if (err.code === 'CAPTURE_PERMISSION_DENIED') {
          permDeniedErr = err;
        } else {
          logger.warn('Capture provider probe threw', {
            providerId: provider.providerId,
            error: err.message
          });
        }
        attempts.push({ providerId: provider.providerId, reason: err.message, passed: false });
        continue;
      }

      const probe = r.value;

      // ── Strict permission policy ────────────────────────────────────────
      // When a provider signals that the binary is present but the OS has
      // denied a mandatory permission, do NOT fall through to slower fallbacks.
      if (probe?.permissionDenied === true) {
        const reason = probe.reason || 'permission denied';
        const err = new Error(reason);
        err.code = 'CAPTURE_PERMISSION_DENIED';
        err.permissionDenied = true;
        err.providerId = provider.providerId;
        permDeniedErr = err;
        attempts.push({ providerId: provider.providerId, reason, passed: false });
        continue;
      }

      if (probe?.canCapture !== false) {
        // Collect ALL passing providers in priority order for failover.
        passing.push(provider);
        attempts.push({ providerId: provider.providerId, reason: 'ok', passed: true });
      } else {
        const reason = probe?.reason || 'not available';
        logger.warn('Capture provider probe rejected', {
          providerId: provider.providerId,
          reason: reason.split('\n')[0]
        });
        attempts.push({
          providerId: provider.providerId,
          reason,
          passed: false,
          detail: probe?.socketPath || probe?.transport || null
        });
      }
    }

    // One consolidated log line shows the full probe picture at a glance.
    logger.info('Parallel capture probe complete', {
      target: `${handle.ref.platform}/${handle.ref.targetClass}`,
      probeMs,
      results: attempts.map((a) => `${a.providerId}:${a.passed ? 'ok' : 'fail'}`).join(' '),
      selected: passing[0]?.providerId ?? (permDeniedErr ? 'permission_denied' : 'none')
    });

    return { passing, permDeniedErr, failed: attempts.filter((a) => !a.passed) };
  }

  _formatCaptureFailure(handle, attempts) {
    const target = `${handle.ref.platform}/${handle.ref.targetClass}`;
    const lines = [`No capture provider available for ${target}.`];
    for (const a of attempts) {
      const detail = a.detail ? ` (${a.detail})` : '';
      lines.push(`  • ${a.providerId}: ${a.reason}${detail}`);
    }
    if (handle.ref.targetClass === 'emulator' || handle.ref.targetClass === 'avd') {
      lines.push(
        'To enable streaming:',
        '  • Ensure scrcpy-server is present and adb can reach the device',
        '  • Or install ffmpeg for adb screenrecord fallback'
      );
    }
    return lines.join('\n');
  }

  /**
   * @param {import('./types').DeviceRef} ref
   * @returns {ILifecycleProvider}
   */
  resolveLifecycle(ref) {
    const platform = ref.platform;
    const priority = (providerConfig.lifecycle || {})[platform] || [];
    const candidates = this._orderedCandidates(this._lifecycle, priority);

    for (const provider of candidates) {
      if (provider.supports(ref)) {
        return provider;
      }
    }

    throw new Error(`No lifecycle provider for ${platform}/${ref.targetClass}`);
  }

  /**
   * @param {import('./types').DeviceHandle} handle
   * @returns {IControlProvider}
   */
  resolveControl(handle) {
    const platform = handle.ref.platform;
    const priority = (providerConfig.control || {})[platform] || [];
    const candidates = this._orderedCandidates(this._control, priority);

    for (const provider of candidates) {
      if (provider.supports(handle)) {
        return provider;
      }
    }

    throw new Error(`No control provider for ${platform}`);
  }

  /**
   * @param {import('./types').DeviceHandle} handle
   */
  resolveAppLifecycle(handle) {
    const platform = handle.ref.platform;
    const priority = (providerConfig.appLifecycle || {})[platform] || [];
    const candidates = this._orderedCandidates(this._appLifecycle, priority);

    for (const provider of candidates) {
      if (provider.supports(handle)) {
        return provider;
      }
    }

    return null; // app lifecycle is optional
  }

  _orderedCandidates(map, priorityIds, strictOnly = false) {
    const ordered = [];
    for (const id of priorityIds) {
      if (map.has(id)) ordered.push(map.get(id));
    }
    if (!strictOnly) {
      for (const provider of map.values()) {
        if (!ordered.includes(provider)) ordered.push(provider);
      }
    }
    return ordered;
  }
}

module.exports = { ProviderRegistry };
