/**
 * Session Manager Module
 * Handles WebSocket client sessions and device mappings
 */

const { v4: uuidv4 } = require('uuid');

/**
 * Logger utility for consistent logging format
 */
const logger = {
  info: (message, data = {}) => {
    console.log(`[SESSION][INFO] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
  },
  error: (message, data = {}) => {
    console.error(`[SESSION][ERROR] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
  },
  warn: (message, data = {}) => {
    console.warn(`[SESSION][WARN] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
  },
  debug: (message, data = {}) => {
    if (process.env.DEBUG === 'true') {
      console.log(`[SESSION][DEBUG] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
    }
  }
};

/**
 * Session class representing a single client session
 */
class Session {
  constructor(id, ws) {
    this.id = id;
    this.ws = ws;
    this.deviceId = null;
    this.emulatorName = null;
    this.ownsEmulator = false; // True if this session started the emulator
    this.createdAt = new Date().toISOString();
    this.lastActivity = new Date().toISOString();
    this.metadata = {};
    this.state = 'active'; // active, disconnecting, disconnected
    
    // Stream state (optional, for future WebRTC streaming support)
    this.streamState = 'idle'; // idle, starting, streaming, stopping
    this.peerConnection = null; // Placeholder for future WebRTC peer connection
  }

  /**
   * Assign a device to this session
   * @param {string} deviceId - The device ID to assign
   */
  assignDevice(deviceId) {
    this.deviceId = deviceId;
    this.updateActivity();
    logger.info(`Device assigned to session`, { sessionId: this.id, deviceId });
  }

  /**
   * Assign an emulator to this session
   * @param {string} emulatorName - The emulator name
   * @param {string} deviceId - The device ID of the emulator
   * @param {boolean} ownsEmulator - Whether this session owns (started) the emulator
   */
  assignEmulator(emulatorName, deviceId, ownsEmulator = true) {
    this.emulatorName = emulatorName;
    this.deviceId = deviceId;
    this.ownsEmulator = ownsEmulator;
    this.updateActivity();
    logger.info(`Emulator assigned to session`, { 
      sessionId: this.id, 
      emulatorName, 
      deviceId,
      ownsEmulator 
    });
  }

  /**
   * Clear device assignment
   */
  clearDevice() {
    const oldDeviceId = this.deviceId;
    const oldEmulatorName = this.emulatorName;
    this.deviceId = null;
    this.emulatorName = null;
    this.ownsEmulator = false;
    this.updateActivity();
    logger.info(`Device cleared from session`, { 
      sessionId: this.id, 
      oldDeviceId,
      oldEmulatorName 
    });
  }

  /**
   * Set stream state
   * @param {string} state - Stream state: idle, starting, streaming, stopping
   */
  setStreamState(state) {
    const validStates = ['idle', 'starting', 'streaming', 'stopping'];
    if (!validStates.includes(state)) {
      logger.warn(`Invalid stream state`, { sessionId: this.id, state });
      return;
    }
    const oldState = this.streamState;
    this.streamState = state;
    this.updateActivity();
    logger.info(`Stream state changed`, { sessionId: this.id, oldState, newState: state });
  }

  /**
   * Attach peer connection placeholder
   * @param {object} peer - Peer connection placeholder
   */
  attachPeer(peer) {
    this.peerConnection = peer;
    this.updateActivity();
    logger.info(`Peer attached to session`, { sessionId: this.id });
  }

  /**
   * Cleanup stream resources
   */
  cleanupStream() {
    const hadPeer = this.peerConnection !== null;
    this.streamState = 'idle';
    this.peerConnection = null;
    this.updateActivity();
    logger.info(`Stream cleaned up`, { sessionId: this.id, hadPeer });
  }

  /**
   * Get stream info
   * @returns {object} - Stream information
   */
  getStreamInfo() {
    return {
      streamState: this.streamState,
      hasPeerConnection: this.peerConnection !== null
    };
  }

  /**
   * Update last activity timestamp
   */
  updateActivity() {
    this.lastActivity = new Date().toISOString();
  }

  /**
   * Set metadata key-value
   * @param {string} key - Metadata key
   * @param {any} value - Metadata value
   */
  setMetadata(key, value) {
    this.metadata[key] = value;
  }

  /**
   * Get session info
   * @returns {object} - Session information
   */
  getInfo() {
    return {
      id: this.id,
      deviceId: this.deviceId,
      emulatorName: this.emulatorName,
      ownsEmulator: this.ownsEmulator,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      state: this.state,
      metadata: this.metadata,
      streamState: this.streamState
    };
  }

  /**
   * Send message to client
   * @param {object} message - Message to send
   */
  send(message) {
    if (this.ws.readyState !== this.ws.OPEN) {
      return;
    }
    try {
      this.ws.send(JSON.stringify(message));
      this.updateActivity();
    } catch (error) {
      logger.warn('Failed to send to client', { sessionId: this.id, error: error.message });
    }
  }

  /**
   * Send success response
   * @param {string} type - Message type
   * @param {object} data - Response data
   * @param {string} requestId - Optional request ID for correlation
   */
  sendSuccess(type, data = {}, requestId = null) {
    const message = {
      type,
      success: true,
      data,
      timestamp: new Date().toISOString()
    };
    if (requestId) {
      message.requestId = requestId;
    }
    this.send(message);
  }

  /**
   * Send error response
   * @param {string} type - Message type
   * @param {string} error - Error message
   * @param {string} requestId - Optional request ID for correlation
   */
  sendError(type, error, requestId = null) {
    const message = {
      type,
      success: false,
      error,
      timestamp: new Date().toISOString()
    };
    if (requestId) {
      message.requestId = requestId;
    }
    this.send(message);
  }
}

/**
 * SessionManager class for managing all client sessions
 */
class SessionManager {
  constructor() {
    // Map: sessionId -> Session
    this.sessions = new Map();
    
    // Map: deviceId -> sessionId (track which session owns which device)
    this.deviceToSession = new Map();
    
    // Callback for session removal (for emulator cleanup)
    this.onSessionRemoveCallback = null;
  }

  /**
   * Set callback to be called when a session is removed
   * @param {function} callback - Async callback(sessionId, session)
   */
  onSessionRemove(callback) {
    this.onSessionRemoveCallback = callback;
  }

  /**
   * Create a new session for a WebSocket connection
   * @param {WebSocket} ws - The WebSocket connection
   * @returns {Session} - The created session
   */
  createSession(ws) {
    const sessionId = uuidv4();
    const session = new Session(sessionId, ws);
    
    this.sessions.set(sessionId, session);
    logger.info(`Session created`, { sessionId });
    
    return session;
  }

  /**
   * Get a session by ID
   * @param {string} sessionId - The session ID
   * @returns {Session|null} - The session or null
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Get session by WebSocket
   * @param {WebSocket} ws - The WebSocket connection
   * @returns {Session|null} - The session or null
   */
  getSessionByWs(ws) {
    for (const session of this.sessions.values()) {
      if (session.ws === ws) {
        return session;
      }
    }
    return null;
  }

  /**
   * Get session by device ID
   * @param {string} deviceId - The device ID
   * @returns {Session|null} - The session or null
   */
  getSessionByDevice(deviceId) {
    const sessionId = this.deviceToSession.get(deviceId);
    return sessionId ? this.getSession(sessionId) : null;
  }

  /**
   * Remove a session
   * @param {string} sessionId - The session ID to remove
   * @param {object} options - Options for removal
   * @returns {Promise<boolean>} - Whether the session was removed
   */
  async removeSession(sessionId, options = {}) {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      logger.warn(`Attempted to remove non-existent session`, { sessionId });
      return false;
    }

    // Mark session as disconnecting
    session.state = 'disconnecting';
    
    // Call removal callback (for emulator cleanup)
    if (this.onSessionRemoveCallback) {
      try {
        await this.onSessionRemoveCallback(sessionId, session, options);
      } catch (error) {
        logger.error(`Error in session remove callback`, { sessionId, error: error.message });
      }
    }
    
    // Clean up device mapping
    if (session.deviceId) {
      this.deviceToSession.delete(session.deviceId);
      logger.info(`Device mapping removed`, { sessionId, deviceId: session.deviceId });
    }
    
    // Mark as disconnected and remove
    session.state = 'disconnected';
    this.sessions.delete(sessionId);
    
    logger.info(`Session removed`, { 
      sessionId,
      duration: Date.now() - new Date(session.createdAt).getTime(),
      hadDevice: !!session.deviceId,
      ownedEmulator: session.ownsEmulator
    });
    
    return true;
  }

  /**
   * Assign a device to a session
   * @param {string} sessionId - The session ID
   * @param {string} deviceId - The device ID
   * @returns {boolean} - Whether the assignment was successful
   */
  assignDevice(sessionId, deviceId) {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      logger.error(`Session not found for device assignment`, { sessionId });
      return false;
    }
    
    // Check if device is already assigned to another session
    const existingSessionId = this.deviceToSession.get(deviceId);
    if (existingSessionId && existingSessionId !== sessionId) {
      logger.error(`Device already assigned to another session`, { 
        deviceId, 
        existingSessionId, 
        requestingSessionId: sessionId 
      });
      return false;
    }
    
    // Clear previous device if any
    if (session.deviceId && session.deviceId !== deviceId) {
      this.deviceToSession.delete(session.deviceId);
    }
    
    session.assignDevice(deviceId);
    this.deviceToSession.set(deviceId, sessionId);
    
    return true;
  }

  /**
   * Clear device from a session
   * @param {string} sessionId - The session ID
   */
  clearDevice(sessionId) {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return;
    }
    
    if (session.deviceId) {
      this.deviceToSession.delete(session.deviceId);
    }
    
    session.clearDevice();
  }

  /**
   * Get all active sessions
   * @returns {Array<object>} - Array of session info objects
   */
  getAllSessions() {
    return Array.from(this.sessions.values()).map(session => session.getInfo());
  }

  /**
   * Get session count
   * @returns {number} - Number of active sessions
   */
  getSessionCount() {
    return this.sessions.size;
  }

  /**
   * Get device mapping count
   * @returns {number} - Number of active device mappings
   */
  getDeviceMappingCount() {
    return this.deviceToSession.size;
  }

  /**
   * Clean up stale sessions
   * @param {number} maxIdleTime - Maximum idle time in milliseconds
   * @returns {number} - Number of sessions cleaned up
   */
  cleanupStaleSessions(maxIdleTime = 3600000) { // Default: 1 hour
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [sessionId, session] of this.sessions.entries()) {
      const lastActivity = new Date(session.lastActivity).getTime();
      
      if (now - lastActivity > maxIdleTime) {
        // Close WebSocket if still open
        if (session.ws.readyState === session.ws.OPEN) {
          session.send({ type: 'session_timeout', message: 'Session timed out due to inactivity' });
          session.ws.close(1000, 'Session timeout');
        }
        
        this.removeSession(sessionId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      logger.info(`Cleaned up stale sessions`, { count: cleanedCount });
    }
    
    return cleanedCount;
  }

  /**
   * Destroy every session except the one being kept (closes their WebSockets).
   * @param {string} keepSessionId
   * @param {object} options - Passed to removeSession (e.g. killEmulator)
   * @returns {Promise<number>} - Number of sessions removed
   */
  async destroyAllOtherSessions(keepSessionId, options = {}) {
    const ids = [...this.sessions.keys()].filter((id) => id !== keepSessionId);
    let removed = 0;

    for (const sessionId of ids) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        continue;
      }

      try {
        if (session.ws.readyState === session.ws.OPEN) {
          session.send({
            type: 'session_destroyed',
            success: true,
            data: {
              session_id: sessionId,
              message: 'Session closed because a new session was created'
            }
          });
          session.ws.close(1000, 'Session replaced');
        }
      } catch (error) {
        logger.warn('Failed notifying replaced session', { sessionId, error: error.message });
      }

      await this.removeSession(sessionId, options);
      removed++;
    }

    return removed;
  }

  /**
   * Broadcast message to all sessions
   * @param {object} message - Message to broadcast
   * @param {function} filter - Optional filter function
   */
  broadcast(message, filter = null) {
    for (const session of this.sessions.values()) {
      if (!filter || filter(session)) {
        session.send(message);
      }
    }
  }

  /**
   * Get statistics
   * @returns {object} - Session statistics
   */
  getStats() {
    const sessions = Array.from(this.sessions.values());
    const withDevice = sessions.filter(s => s.deviceId !== null).length;
    
    return {
      totalSessions: this.sessions.size,
      sessionsWithDevice: withDevice,
      sessionsWithoutDevice: this.sessions.size - withDevice,
      deviceMappings: this.deviceToSession.size
    };
  }
}

// Export singleton instance and class
const sessionManager = new SessionManager();

module.exports = {
  sessionManager,
  SessionManager,
  Session,
  logger
};
