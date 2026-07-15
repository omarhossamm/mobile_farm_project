/**
 * Control plane — forwards tap/swipe/key to the active capture session.
 */

const { createLogger } = require('../lib/logger');

const logger = createLogger('CONTROL');

class ControlRouter {
  constructor() {
    this._captures = new Map();
    this._stats = new Map();
  }

  registerRuntime(sessionId, capture) {
    if (sessionId && capture) {
      this._captures.set(sessionId, capture);
    }
  }

  unregisterRuntime(sessionId) {
    this._captures.delete(sessionId);
    this._stats.delete(sessionId);
  }

  getRuntime(sessionId) {
    return this._captures.get(sessionId) || null;
  }

  async handleControl(sessionId, event) {
    const capture = this._captures.get(sessionId);
    if (!capture) {
      return { success: false, error: 'No device capture for session (start stream first)' };
    }

    const stats = this._stats.get(sessionId) || { events: 0, errors: 0 };
    stats.events++;
    this._stats.set(sessionId, stats);

    const result = await capture.injectInput(event);
    if (!result.success) {
      stats.errors++;
      logger.error('Control failed', { sessionId, error: result.error });
    }
    return result;
  }

  getStats(sessionId) {
    return this._stats.get(sessionId) || { events: 0, errors: 0 };
  }
}

const controlRouter = new ControlRouter();

module.exports = { controlRouter };
