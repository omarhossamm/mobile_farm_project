/**
 * Shared logger factory — one place for log format and debug gating.
 */

function createLogger(tag) {
  const prefix = `[${tag}]`;
  return {
    info(message, data = {}) {
      console.log(`${prefix}[INFO] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
    },
    warn(message, data = {}) {
      console.warn(`${prefix}[WARN] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
    },
    error(message, data = {}) {
      console.error(`${prefix}[ERROR] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
    },
    debug(message, data = {}) {
      if (process.env.DEBUG === 'true') {
        console.log(`${prefix}[DEBUG] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
      }
    }
  };
}

module.exports = { createLogger };
