/**
 * Emulator Manager Module
 * Manages emulator lifecycle with session binding
 * Tracks which sessions own which emulators for cleanup on disconnect
 */

const emulator = require('./emulator');
const adb = require('./adb');

/**
 * Logger utility for consistent logging format
 */
const logger = {
  info: (message, data = {}) => {
    console.log(`[EMU_MGR][INFO] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
  },
  error: (message, data = {}) => {
    console.error(`[EMU_MGR][ERROR] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
  },
  debug: (message, data = {}) => {
    if (process.env.DEBUG === 'true') {
      console.log(`[EMU_MGR][DEBUG] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
    }
  }
};

/**
 * EmulatorManager class
 * Handles emulator-to-session binding and lifecycle management
 */
class EmulatorManager {
  constructor() {
    // Map: deviceId -> { sessionId, emulatorName, startedAt, ownedBySession }
    this.activeEmulators = new Map();
    
    // Map: emulatorName -> deviceId (for quick lookup of running emulators by name)
    this.emulatorNameToDevice = new Map();
    
    // Map: sessionId -> Set of deviceIds (emulators owned by this session)
    this.sessionEmulators = new Map();
    
    // Configuration
    this.killOnDisconnect = process.env.KILL_EMULATOR_ON_DISCONNECT !== 'false';
  }

  /**
   * Get or start an emulator for a session
   * If the emulator is already running, bind it to the session
   * If not, start it and bind it
   * 
   * @param {string} sessionId - The session requesting the emulator
   * @param {string} emulatorName - The AVD name to start
   * @param {object} options - Emulator start options
   * @returns {Promise<{success: boolean, deviceId?: string, alreadyRunning?: boolean, error?: string}>}
   */
  async getOrStartEmulator(sessionId, emulatorName, options = {}) {
    logger.info(`Getting or starting emulator`, { sessionId, emulatorName });

    // Check if this emulator is already running
    const existingDeviceId = this.emulatorNameToDevice.get(emulatorName);
    
    if (existingDeviceId) {
      const emulatorInfo = this.activeEmulators.get(existingDeviceId);
      
      // Check if it's owned by another session
      if (emulatorInfo && emulatorInfo.sessionId && emulatorInfo.sessionId !== sessionId) {
        logger.error(`Emulator already in use by another session`, {
          emulatorName,
          deviceId: existingDeviceId,
          ownerSessionId: emulatorInfo.sessionId,
          requestingSessionId: sessionId
        });
        return {
          success: false,
          error: `Emulator ${emulatorName} is already in use by another session`
        };
      }

      // Verify it's still connected
      const devices = await adb.getDevices();
      const device = devices.devices.find(d => d.device_id === existingDeviceId && d.status === 'online');
      
      if (device) {
        // Bind to this session
        this._bindEmulatorToSession(existingDeviceId, emulatorName, sessionId);
        
        logger.info(`Reusing existing emulator`, { sessionId, emulatorName, deviceId: existingDeviceId });
        return {
          success: true,
          deviceId: existingDeviceId,
          alreadyRunning: true
        };
      } else {
        // Device no longer available, clean up stale mapping
        this._cleanupEmulator(existingDeviceId);
      }
    }

    // Start new emulator
    logger.info(`Starting new emulator`, { sessionId, emulatorName });
    
    const result = await emulator.startEmulator(emulatorName, options);
    
    if (!result.success) {
      logger.error(`Failed to start emulator`, { sessionId, emulatorName, error: result.error });
      return {
        success: false,
        error: result.error
      };
    }

    // Bind to session
    this._bindEmulatorToSession(result.deviceId, emulatorName, sessionId);

    logger.info(`Emulator started and bound to session`, {
      sessionId,
      emulatorName,
      deviceId: result.deviceId
    });

    return {
      success: true,
      deviceId: result.deviceId,
      alreadyRunning: false
    };
  }

  /**
   * Bind an emulator to a session
   * @private
   */
  _bindEmulatorToSession(deviceId, emulatorName, sessionId) {
    // Update activeEmulators
    this.activeEmulators.set(deviceId, {
      sessionId,
      emulatorName,
      startedAt: new Date().toISOString(),
      ownedBySession: true
    });

    // Update emulatorNameToDevice
    this.emulatorNameToDevice.set(emulatorName, deviceId);

    // Update sessionEmulators
    if (!this.sessionEmulators.has(sessionId)) {
      this.sessionEmulators.set(sessionId, new Set());
    }
    this.sessionEmulators.get(sessionId).add(deviceId);

    logger.info(`Device assigned to session`, { sessionId, deviceId, emulatorName });
  }

  /**
   * Unbind an emulator from a session without stopping it
   * @param {string} deviceId - The device ID
   * @param {string} sessionId - The session ID
   */
  unbindEmulator(deviceId, sessionId) {
    const emulatorInfo = this.activeEmulators.get(deviceId);
    
    if (emulatorInfo && emulatorInfo.sessionId === sessionId) {
      emulatorInfo.sessionId = null;
      emulatorInfo.ownedBySession = false;
      
      // Remove from session's emulator set
      const sessionEmus = this.sessionEmulators.get(sessionId);
      if (sessionEmus) {
        sessionEmus.delete(deviceId);
        if (sessionEmus.size === 0) {
          this.sessionEmulators.delete(sessionId);
        }
      }

      logger.info(`Emulator unbound from session`, { sessionId, deviceId });
    }
  }

  /**
   * Clean up emulator tracking data
   * @private
   */
  _cleanupEmulator(deviceId) {
    const info = this.activeEmulators.get(deviceId);
    
    if (info) {
      this.emulatorNameToDevice.delete(info.emulatorName);
      
      if (info.sessionId) {
        const sessionEmus = this.sessionEmulators.get(info.sessionId);
        if (sessionEmus) {
          sessionEmus.delete(deviceId);
          if (sessionEmus.size === 0) {
            this.sessionEmulators.delete(info.sessionId);
          }
        }
      }
    }
    
    this.activeEmulators.delete(deviceId);
  }

  /**
   * Handle session disconnect - cleanup emulators owned by the session
   * @param {string} sessionId - The disconnecting session ID
   * @param {boolean} killEmulators - Whether to kill the emulators (default: based on config)
   * @returns {Promise<{cleaned: string[], errors: string[]}>}
   */
  async handleSessionDisconnect(sessionId, killEmulators = this.killOnDisconnect) {
    logger.info(`Handling session disconnect`, { sessionId, killEmulators });
    
    const sessionEmus = this.sessionEmulators.get(sessionId);
    
    if (!sessionEmus || sessionEmus.size === 0) {
      logger.debug(`No emulators to clean up for session`, { sessionId });
      return { cleaned: [], errors: [] };
    }

    const cleaned = [];
    const errors = [];
    const deviceIds = Array.from(sessionEmus);

    for (const deviceId of deviceIds) {
      const info = this.activeEmulators.get(deviceId);
      
      if (killEmulators) {
        logger.info(`Killing emulator on session disconnect`, { sessionId, deviceId });
        
        const result = await emulator.stopEmulator(deviceId);
        
        if (result.success) {
          cleaned.push(deviceId);
          logger.info(`Emulator stopped`, { sessionId, deviceId });
        } else {
          errors.push(`${deviceId}: ${result.error}`);
          logger.error(`Failed to stop emulator`, { sessionId, deviceId, error: result.error });
        }
      } else {
        // Just unbind, don't kill
        logger.info(`Unbinding emulator on session disconnect (not killing)`, { sessionId, deviceId });
        cleaned.push(deviceId);
      }
      
      this._cleanupEmulator(deviceId);
    }

    this.sessionEmulators.delete(sessionId);
    
    logger.info(`Session disconnect cleanup complete`, { 
      sessionId, 
      cleaned: cleaned.length, 
      errors: errors.length 
    });

    return { cleaned, errors };
  }

  /**
   * Stop an emulator and clean up
   * @param {string} deviceId - The device ID to stop
   * @param {string} sessionId - The requesting session ID (for ownership check)
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async stopEmulator(deviceId, sessionId = null) {
    const info = this.activeEmulators.get(deviceId);
    
    // Check ownership if sessionId provided
    if (sessionId && info && info.sessionId && info.sessionId !== sessionId) {
      return {
        success: false,
        error: 'Cannot stop emulator owned by another session'
      };
    }

    const result = await emulator.stopEmulator(deviceId);
    
    if (result.success) {
      this._cleanupEmulator(deviceId);
    }
    
    return result;
  }

  /**
   * Get emulator info by device ID
   * @param {string} deviceId - The device ID
   * @returns {object|null}
   */
  getEmulatorInfo(deviceId) {
    return this.activeEmulators.get(deviceId) || null;
  }

  /**
   * Get all emulators for a session
   * @param {string} sessionId - The session ID
   * @returns {Array<{deviceId: string, info: object}>}
   */
  getSessionEmulators(sessionId) {
    const deviceIds = this.sessionEmulators.get(sessionId);
    
    if (!deviceIds) {
      return [];
    }

    return Array.from(deviceIds).map(deviceId => ({
      deviceId,
      info: this.activeEmulators.get(deviceId)
    }));
  }

  /**
   * Check if a device is owned by a session
   * @param {string} deviceId - The device ID
   * @param {string} sessionId - The session ID
   * @returns {boolean}
   */
  isOwnedBySession(deviceId, sessionId) {
    const info = this.activeEmulators.get(deviceId);
    return info && info.sessionId === sessionId;
  }

  /**
   * Get statistics
   * @returns {object}
   */
  getStats() {
    return {
      activeEmulators: this.activeEmulators.size,
      sessionsWithEmulators: this.sessionEmulators.size,
      emulatorsBySession: Array.from(this.sessionEmulators.entries()).map(([sessionId, devices]) => ({
        sessionId,
        deviceCount: devices.size,
        devices: Array.from(devices)
      }))
    };
  }

  /**
   * Sync with actual running emulators
   * Useful for detecting emulators that crashed or were started externally
   * @returns {Promise<{added: number, removed: number}>}
   */
  async syncWithRunningEmulators() {
    const devices = await adb.getDevices();
    const runningEmulators = devices.devices.filter(d => d.device_id.startsWith('emulator-'));
    const runningIds = new Set(runningEmulators.map(d => d.device_id));
    
    let removed = 0;
    let added = 0;

    // Remove entries for emulators that are no longer running
    for (const deviceId of this.activeEmulators.keys()) {
      if (!runningIds.has(deviceId)) {
        this._cleanupEmulator(deviceId);
        removed++;
      }
    }

    // Add entries for emulators running but not tracked (started externally)
    for (const device of runningEmulators) {
      if (!this.activeEmulators.has(device.device_id)) {
        this.activeEmulators.set(device.device_id, {
          sessionId: null,
          emulatorName: null, // Unknown
          startedAt: null,
          ownedBySession: false
        });
        added++;
      }
    }

    if (removed > 0 || added > 0) {
      logger.info(`Synced with running emulators`, { removed, added });
    }

    return { added, removed };
  }
}

// Export singleton instance
const emulatorManager = new EmulatorManager();

module.exports = {
  emulatorManager,
  EmulatorManager,
  logger
};
