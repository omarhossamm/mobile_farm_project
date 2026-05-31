/**
 * Android Emulator Control Server
 * WebSocket server for controlling Android emulators via ADB
 */

const WebSocket = require('ws');
const http = require('http');
const adb = require('./adb');
const emulator = require('./emulator');
const { emulatorManager } = require('./emulatorManager');
const { sessionManager } = require('./sessionManager');
const { webrtcSignaling } = require('./webrtcSignaling');
const { controlRouter } = require('./control/ControlRouter');
const { streamConfig } = require('./lib/config');
const { streamManager } = require('./stream');
const { buildDeviceCatalog, resolveAvdNameForDevice } = require('./devicesCatalog');

// Configuration
const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL, 10) || 30000;
const SESSION_CLEANUP_INTERVAL = parseInt(process.env.SESSION_CLEANUP_INTERVAL, 10) || 300000; // 5 minutes
const KILL_EMULATOR_ON_DISCONNECT = process.env.KILL_EMULATOR_ON_DISCONNECT !== 'false';

/**
 * Logger utility for consistent logging format
 */
const logger = {
  info: (message, data = {}) => {
    console.log(`[SERVER][INFO] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
  },
  warn: (message, data = {}) => {
    console.warn(`[SERVER][WARN] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
  },
  error: (message, data = {}) => {
    console.error(`[SERVER][ERROR] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
  },
  debug: (message, data = {}) => {
    if (process.env.DEBUG === 'true') {
      console.log(`[SERVER][DEBUG] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
    }
  }
};

/**
 * Stop stream and unbind device from a session without closing its WebSocket.
 */
async function releaseSessionDevice(session, { killEmulator = KILL_EMULATOR_ON_DISCONNECT } = {}) {
  if (session.streamState !== 'idle') {
    streamManager.stopStream(session.id);
    webrtcSignaling.closeSession(session.id);
    session.cleanupStream();
  }

  if (!session.deviceId) {
    return { released: false };
  }

  const deviceId = session.deviceId;
  const emulatorName = session.emulatorName;
  const ownsEmulator = session.ownsEmulator;

  if (killEmulator && ownsEmulator) {
    const result = await emulatorManager.stopEmulator(deviceId, session.id);
    if (!result.success) {
      logger.error('Failed to stop emulator during session release', {
        sessionId: session.id,
        deviceId,
        error: result.error
      });
    }
  } else {
    emulatorManager.unbindEmulator(deviceId, session.id);
  }

  sessionManager.clearDevice(session.id);

  return {
    released: true,
    deviceId,
    emulatorName,
    emulatorKilled: killEmulator && ownsEmulator
  };
}

/**
 * Message handler registry
 */
const messageHandlers = {
  /**
   * Ping/pong for connection health
   */
  ping: async (session, payload) => {
    session.sendSuccess('pong', { timestamp: new Date().toISOString() }, payload.requestId);
  },

  /**
   * Get session information
   */
  get_session: async (session, payload) => {
    session.sendSuccess('session_info', session.getInfo(), payload.requestId);
  },

  /**
   * Create session with device/emulator binding
   * Main entry point for clients to get an emulator
   * Accepts either an AVD name (to start) or a device_id (to bind to existing)
   */
  create_session: async (session, payload) => {
    const { device, options = {} } = payload;
    
    if (!device) {
      session.sendError('session_created', 'device (emulator name or device_id) is required', payload.requestId);
      return;
    }

    const removed = await sessionManager.destroyAllOtherSessions(session.id, {
      killEmulator: KILL_EMULATOR_ON_DISCONNECT
    });
    if (removed > 0) {
      logger.info('Destroyed previous sessions before create_session', {
        sessionId: session.id,
        removed
      });
    }

    if (session.deviceId) {
      await releaseSessionDevice(session, { killEmulator: KILL_EMULATOR_ON_DISCONNECT });
    }

    // Check if 'device' is actually a device_id of an already running device
    const isDeviceId = device.startsWith('emulator-') || device.includes(':');
    
    if (isDeviceId) {
      // User passed a device_id - bind to existing device
      logger.info(`Binding session to existing device`, { sessionId: session.id, deviceId: device });
      
      // Verify device exists and is online
      const devicesResult = await adb.getDevices();
      const existingDevice = devicesResult.devices.find(d => d.device_id === device);
      
      if (!existingDevice) {
        session.sendError('session_created', `Device ${device} not found. Use get_devices to see available devices.`, payload.requestId);
        return;
      }
      
      if (existingDevice.status !== 'online') {
        let avdName = null;

        const catalog = await buildDeviceCatalog();
        const catalogEntry = catalog.devices.find((entry) => entry.device_id === device);
        if (catalogEntry?.avd_name) {
          avdName = catalogEntry.avd_name;
        }

        if (!avdName) {
          const emuInfo = emulatorManager.getEmulatorInfo(device);
          avdName = emuInfo?.emulatorName || null;
        }

        if (!avdName && device.startsWith('emulator-')) {
          avdName = await resolveAvdNameForDevice(device);
        }

        if (avdName) {
          logger.info('Offline device selected — starting AVD on server', {
            sessionId: session.id,
            deviceId: device,
            avdName,
            status: existingDevice.status
          });

          session.send({
            type: 'session_creating',
            device: avdName,
            message: 'Device is offline. Starting emulator on server...',
            requestId: payload.requestId
          });

          const startResult = await emulatorManager.getOrStartEmulator(session.id, avdName, options);
          if (!startResult.success) {
            session.sendError('session_created', startResult.error, payload.requestId);
            return;
          }

          session.assignEmulator(avdName, startResult.deviceId, !startResult.alreadyRunning);
          sessionManager.assignDevice(session.id, startResult.deviceId);

          session.sendSuccess('session_created', {
            session_id: session.id,
            device_id: startResult.deviceId,
            emulator_name: avdName,
            already_running: startResult.alreadyRunning,
            started_from_offline: true
          }, payload.requestId);
          return;
        }

        session.sendError(
          'session_created',
          `Device ${device} is ${existingDevice.status}. Select the AVD name from the list to start it on the server.`,
          payload.requestId
        );
        return;
      }
      
      // Check if device is already bound to another session
      const existingSession = sessionManager.getSessionByDevice(device);
      if (existingSession && existingSession.id !== session.id) {
        session.sendError('session_created', `Device ${device} is already bound to another session`, payload.requestId);
        return;
      }
      
      // Bind to session (ownsEmulator = false since we didn't start it)
      session.assignEmulator(null, device, false);
      sessionManager.assignDevice(session.id, device);
      
      logger.info(`Session bound to existing device`, {
        sessionId: session.id,
        deviceId: device
      });
      
      session.sendSuccess('session_created', {
        session_id: session.id,
        device_id: device,
        emulator_name: null,
        already_running: true,
        bound_to_existing: true
      }, payload.requestId);
      return;
    }

    // User passed an AVD name - start or get emulator
    logger.info(`Creating session with emulator`, { sessionId: session.id, device });

    // Send acknowledgment
    session.send({
      type: 'session_creating',
      device,
      message: 'Starting emulator, this may take a few minutes...',
      requestId: payload.requestId
    });

    // Get or start emulator
    const result = await emulatorManager.getOrStartEmulator(session.id, device, options);

    if (!result.success) {
      session.sendError('session_created', result.error, payload.requestId);
      return;
    }

    // Bind to session
    session.assignEmulator(device, result.deviceId, true);
    sessionManager.assignDevice(session.id, result.deviceId);

    logger.info(`Session created with device`, {
      sessionId: session.id,
      device,
      deviceId: result.deviceId,
      alreadyRunning: result.alreadyRunning
    });

    session.sendSuccess('session_created', {
      session_id: session.id,
      device_id: result.deviceId,
      emulator_name: device,
      already_running: result.alreadyRunning
    }, payload.requestId);
  },

  /**
   * Destroy session - unbind and optionally stop emulator
   */
  destroy_session: async (session, payload) => {
    const { kill_emulator = true } = payload;

    if (session.streamState !== 'idle') {
      logger.info('Destroy session - stopping active stream first', {
        sessionId: session.id,
        streamState: session.streamState
      });
    }

    const released = await releaseSessionDevice(session, { killEmulator: kill_emulator });

    if (!released.released) {
      session.sendSuccess('session_destroyed', {
        session_id: session.id,
        message: 'No device was bound to session'
      }, payload.requestId);
      return;
    }

    session.sendSuccess('session_destroyed', {
      session_id: session.id,
      device_id: released.deviceId,
      emulator_name: released.emulatorName,
      emulator_killed: released.emulatorKilled
    }, payload.requestId);
  },

  /**
   * Alias for list_emulators
   */
  get_emulators: async (session, payload) => {
    const result = await emulator.listAvailableEmulators();
    
    if (result.success) {
      session.sendSuccess('emulators_list', { avds: result.avds }, payload.requestId);
    } else {
      session.sendError('emulators_list', result.error, payload.requestId);
    }
  },

  /**
   * Start an emulator
   */
  start_emulator: async (session, payload) => {
    const { emulator_name, options = {} } = payload;
    
    if (!emulator_name) {
      session.sendError('emulator_started', 'emulator_name is required', payload.requestId);
      return;
    }
    
    // Send acknowledgment
    session.send({ 
      type: 'emulator_starting', 
      emulator_name,
      message: 'Starting emulator, this may take a few minutes...',
      requestId: payload.requestId
    });
    
    const result = await emulatorManager.getOrStartEmulator(session.id, emulator_name, options);
    
    if (result.success) {
      // Assign the emulator to this session
      session.assignEmulator(emulator_name, result.deviceId, !result.alreadyRunning);
      sessionManager.assignDevice(session.id, result.deviceId);
      
      session.sendSuccess('emulator_started', {
        emulator_name,
        device_id: result.deviceId,
        already_running: result.alreadyRunning
      }, payload.requestId);
    } else {
      session.sendError('emulator_started', result.error, payload.requestId);
    }
  },

  /**
   * Stop an emulator
   */
  stop_emulator: async (session, payload) => {
    const deviceId = payload.device_id || session.deviceId;
    
    if (!deviceId) {
      session.sendError('emulator_stopped', 'device_id is required or no device assigned to session', payload.requestId);
      return;
    }
    
    const result = await emulatorManager.stopEmulator(deviceId, session.id);
    
    if (result.success) {
      // Clear device from session if it matches
      if (session.deviceId === deviceId) {
        sessionManager.clearDevice(session.id);
      }
      
      session.sendSuccess('emulator_stopped', { device_id: deviceId }, payload.requestId);
    } else {
      session.sendError('emulator_stopped', result.error, payload.requestId);
    }
  },

  /**
   * Get emulator status
   */
  emulator_status: async (session, payload) => {
    const result = await emulator.getEmulatorStatus();
    session.sendSuccess('emulator_status', result, payload.requestId);
  },

  /**
   * Get connected devices
   */
  get_devices: async (session, payload) => {
    const result = await buildDeviceCatalog();
    
    if (result.success) {
      session.sendSuccess('devices_list', {
        devices: result.devices,
        avd_list_error: result.avd_list_error
      }, payload.requestId);
    } else {
      session.sendError('devices_list', result.error, payload.requestId);
    }
  },

  /**
   * Assign a device to the current session
   */
  assign_device: async (session, payload) => {
    const { device_id } = payload;
    
    if (!device_id) {
      session.sendError('device_assigned', 'device_id is required', payload.requestId);
      return;
    }
    
    // Verify device exists
    const devices = await adb.getDevices();
    const device = devices.devices.find(d => d.device_id === device_id);
    
    if (!device) {
      session.sendError('device_assigned', `Device ${device_id} not found`, payload.requestId);
      return;
    }
    
    if (device.status !== 'online') {
      session.sendError('device_assigned', `Device ${device_id} is not ready (status: ${device.status})`, payload.requestId);
      return;
    }
    
    const assigned = sessionManager.assignDevice(session.id, device_id);
    
    if (assigned) {
      session.sendSuccess('device_assigned', { device_id }, payload.requestId);
    } else {
      session.sendError('device_assigned', `Could not assign device ${device_id}. It may be in use by another session.`, payload.requestId);
    }
  },

  /**
   * Execute ADB command on a device
   */
  adb_command: async (session, payload) => {
    const deviceId = payload.device_id || session.deviceId;
    const { command } = payload;
    
    if (!deviceId) {
      session.sendError('adb_result', 'device_id is required or no device assigned to session', payload.requestId);
      return;
    }
    
    if (!command) {
      session.sendError('adb_result', 'command is required', payload.requestId);
      return;
    }
    
    const result = await adb.deviceCommand(deviceId, command);
    
    if (result.success) {
      session.sendSuccess('adb_result', {
        device_id: deviceId,
        command,
        output: result.output
      }, payload.requestId);
    } else {
      session.sendError('adb_result', result.error, payload.requestId);
    }
  },

  /**
   * Execute shell command on a device
   */
  shell_command: async (session, payload) => {
    const deviceId = payload.device_id || session.deviceId;
    const { command } = payload;
    
    if (!deviceId) {
      session.sendError('shell_result', 'device_id is required or no device assigned to session', payload.requestId);
      return;
    }
    
    if (!command) {
      session.sendError('shell_result', 'command is required', payload.requestId);
      return;
    }
    
    // Prepend 'shell' if not already present
    const fullCommand = command.startsWith('shell ') ? command : `shell ${command}`;
    const result = await adb.deviceCommand(deviceId, fullCommand);
    
    if (result.success) {
      session.sendSuccess('shell_result', {
        device_id: deviceId,
        command,
        output: result.output
      }, payload.requestId);
    } else {
      session.sendError('shell_result', result.error, payload.requestId);
    }
  },

  /**
   * Install APK on a device
   */
  install_apk: async (session, payload) => {
    const deviceId = payload.device_id || session.deviceId;
    const { apk_path } = payload;
    
    if (!deviceId) {
      session.sendError('apk_installed', 'device_id is required or no device assigned to session', payload.requestId);
      return;
    }
    
    if (!apk_path) {
      session.sendError('apk_installed', 'apk_path is required', payload.requestId);
      return;
    }
    
    const result = await adb.installApk(deviceId, apk_path);
    
    if (result.success) {
      session.sendSuccess('apk_installed', {
        device_id: deviceId,
        apk_path,
        output: result.output
      }, payload.requestId);
    } else {
      session.sendError('apk_installed', result.error, payload.requestId);
    }
  },

  /**
   * Take screenshot from a device
   */
  screenshot: async (session, payload) => {
    const deviceId = payload.device_id || session.deviceId;
    const { local_path } = payload;
    
    if (!deviceId) {
      session.sendError('screenshot_taken', 'device_id is required or no device assigned to session', payload.requestId);
      return;
    }
    
    if (!local_path) {
      session.sendError('screenshot_taken', 'local_path is required', payload.requestId);
      return;
    }
    
    const result = await adb.takeScreenshot(deviceId, local_path);
    
    if (result.success) {
      session.sendSuccess('screenshot_taken', {
        device_id: deviceId,
        path: result.output
      }, payload.requestId);
    } else {
      session.sendError('screenshot_taken', result.error, payload.requestId);
    }
  },

  /**
   * Reboot device
   */
  reboot: async (session, payload) => {
    const deviceId = payload.device_id || session.deviceId;
    const { mode = 'system' } = payload;
    
    if (!deviceId) {
      session.sendError('reboot_initiated', 'device_id is required or no device assigned to session', payload.requestId);
      return;
    }
    
    const result = await adb.rebootDevice(deviceId, mode);
    
    if (result.success) {
      session.sendSuccess('reboot_initiated', {
        device_id: deviceId,
        mode
      }, payload.requestId);
    } else {
      session.sendError('reboot_initiated', result.error, payload.requestId);
    }
  },

  /**
   * Get server statistics
   */
  server_stats: async (session, payload) => {
    const sessionStats = sessionManager.getStats();
    const emulatorStats = emulatorManager.getStats();
    const devices = await adb.getDevices();
    
    session.sendSuccess('server_stats', {
      sessions: sessionStats,
      emulators: emulatorStats,
      connectedDevices: devices.devices.length,
      uptime: process.uptime()
    }, payload.requestId);
  },

  // ============================================
  // REAL WebRTC Video Streaming Handlers
  // ============================================

  /**
   * Start stream - creates real WebRTC video stream
   */
  start_stream: async (session, payload) => {
    if (!session.deviceId) {
      session.sendError('stream_started', 'No device assigned to session. Create a session first.', payload.requestId);
      return;
    }

    // Check if already streaming
    if (session.streamState === 'streaming' || session.streamState === 'starting') {
      session.sendError('stream_started', `Stream already ${session.streamState}`, payload.requestId);
      return;
    }

    // Set stream state to starting
    session.setStreamState('starting');

    logger.info('Starting server WebRTC stream (adb screenrecord)', {
      sessionId: session.id,
      deviceId: session.deviceId
    });

    webrtcSignaling.initializeSession(session.id);

    const streamResult = await streamManager.startStream(session, payload.options || {});
    if (!streamResult.success) {
      session.setStreamState('idle');
      session.sendError('stream_started', streamResult.error, payload.requestId);
      return;
    }

    const offer = streamResult.offer?.sdp
      ? { type: streamResult.offer.type || 'offer', sdp: streamResult.offer.sdp }
      : streamResult.offer;

    logger.info('Server WebRTC offer ready', {
      sessionId: session.id,
      sdpLength: offer?.sdp?.length
    });

    session.sendSuccess('stream_started', {
      session_id: session.id,
      device_id: session.deviceId,
      stream_state: session.streamState,
      stream_mode: 'server_webrtc_screenrecord',
      webrtc_offer: offer,
      message: 'adb screenrecord → H.264 RTP (werift). Send webrtc_answer + ICE.'
    }, payload.requestId);
  },

  /**
   * Stop stream - cleanup WebRTC and pipeline
   */
  stop_stream: async (session, payload) => {
    if (session.streamState === 'idle') {
      session.sendSuccess('stream_stopped', {
        session_id: session.id,
        message: 'No active stream to stop'
      }, payload.requestId);
      return;
    }

    // Set stream state to stopping
    session.setStreamState('stopping');

    streamManager.stopStream(session.id);
    webrtcSignaling.closeSession(session.id);
    session.cleanupStream();

    logger.info('Stream stopped', { sessionId: session.id });

    session.sendSuccess('stream_stopped', {
      session_id: session.id,
      stream_state: session.streamState,
      stream_mode: 'server_webrtc_screenrecord',
      message: 'Server screenrecord WebRTC stream stopped'
    }, payload.requestId);
  },

  /**
   * Get stream status
   */
  stream_status: async (session, payload) => {
    const signalingState = webrtcSignaling.getSignalingState(session.id);
    const runtime = controlRouter.getRuntime(session.id);

    session.sendSuccess('stream_status', {
      session_id: session.id,
      device_id: session.deviceId,
      stream_state: session.streamState,
      stream_mode: 'server_webrtc_screenrecord',
      capture: 'adb exec-out screenrecord → H.264 → werift RTP',
      stream_active: streamManager.hasSession(session.id),
      stream_info: session.getStreamInfo(),
      signaling: signalingState ? {
        state: signalingState.state,
        offerReceived: signalingState.offerReceived,
        answerReceived: signalingState.answerReceived,
        iceCandidatesCount: signalingState.iceCandidates.length
      } : null,
      control: runtime ? runtime.getStatus() : null
    }, payload.requestId);
  },

  /**
   * Handle WebRTC offer from client (client-initiated)
   */
  webrtc_offer: async (session, payload) => {
    session.sendError(
      'webrtc_offer_received',
      'Server does not accept client offers. Call start_stream and use the server offer from stream_started.',
      payload.requestId
    );
  },

  /**
   * Handle WebRTC answer from client (server-initiated offer)
   */
  webrtc_answer: async (session, payload) => {
    // Support both formats:
    // { sdp: "..." } or { answer: { type: "answer", sdp: "..." } }
    const sdp = payload.sdp || payload.answer?.sdp;
    const answerType = payload.answer?.type || 'answer';

    if (!sdp) {
      logger.error('WebRTC answer missing SDP', { 
        sessionId: session.id, 
        hasPayloadSdp: !!payload.sdp,
        hasAnswerSdp: !!payload.answer?.sdp
      });
      session.sendError('webrtc_answer_received', 'sdp is required', payload.requestId);
      return;
    }

    logger.info('WebRTC answer received', { 
      sessionId: session.id,
      sdpLength: sdp.length,
      answerType
    });

    webrtcSignaling.handleAnswer(session.id, sdp);

    if (!streamManager.hasSession(session.id)) {
      session.sendError(
        'webrtc_answer_received',
        'No active stream. Call start_stream first and wait for stream_started.',
        payload.requestId
      );
      return;
    }

    const relay = await streamManager.handleAnswer(session.id, { type: answerType, sdp });
    if (relay.success) {
      session.setStreamState('streaming');
      session.sendSuccess('webrtc_answer_received', {
        session_id: session.id,
        stream_mode: 'server_webrtc_screenrecord',
        message: 'Answer applied — server is sending screenrecord H.264 over WebRTC'
      }, payload.requestId);
    } else {
      session.sendError('webrtc_answer_received', relay.error, payload.requestId);
    }
  },

  /**
   * Remote control — tap, swipe, key, text (separate from video WebRTC).
   */
  control: async (session, payload) => {
    if (!session.deviceId) {
      session.sendError('control_result', 'No device assigned to session', payload.requestId);
      return;
    }

    const event = payload.event || payload;
    if (!event?.action) {
      session.sendError('control_result', 'event.action is required (tap|swipe|key|text)', payload.requestId);
      return;
    }

    const result = await controlRouter.handleControl(session.id, event);

    if (result.success) {
      session.sendSuccess('control_result', {
        session_id: session.id,
        action: event.action,
        ...result
      }, payload.requestId);
    } else {
      session.sendError('control_result', result.error || 'Control failed', payload.requestId);
    }
  },

  /**
   * Stream + capture telemetry for debugging FPS/latency.
   */
  stream_stats: async (session, payload) => {
    const runtime = controlRouter.getRuntime(session.id);
    const controlStats = controlRouter.getStats(session.id);

    session.sendSuccess('stream_stats', {
      session_id: session.id,
      stream_state: session.streamState,
      stream_mode: 'server_webrtc_screenrecord',
      stream_active: streamManager.hasSession(session.id),
      runtime: runtime ? runtime.getStatus() : null,
      pipeline: streamManager.getStats(session.id),
      control: controlStats
    }, payload.requestId);
  },

  /**
   * Handle ICE candidate from client
   */
  ice_candidate: async (session, payload) => {
    const { candidate } = payload;

    if (!candidate) {
      session.sendError('ice_candidate_received', 'candidate is required', payload.requestId);
      return;
    }

    logger.debug('Received ICE candidate from client', { sessionId: session.id });

    webrtcSignaling.handleIceCandidate(session.id, candidate);

    if (!streamManager.hasSession(session.id)) {
      session.sendError(
        'ice_candidate_received',
        'No active stream. Call start_stream and wait for stream_started before sending ICE.',
        payload.requestId
      );
      return;
    }

    const relay = await streamManager.addIceCandidate(session.id, candidate);
    if (relay.success) {
      session.sendSuccess('ice_candidate_received', {
        session_id: session.id,
        message: 'ICE candidate applied to server peer'
      }, payload.requestId);
    } else {
      session.sendError('ice_candidate_received', relay.error, payload.requestId);
    }
  }
};

/**
 * Handle incoming WebSocket message
 * @param {Session} session - The client session
 * @param {string} rawMessage - The raw message string
 */
async function handleMessage(session, rawMessage) {
  let message;
  
  try {
    message = JSON.parse(rawMessage);
  } catch (error) {
    session.sendError('error', 'Invalid JSON message');
    return;
  }
  
  const { type } = message;
  
  if (!type) {
    session.sendError('error', 'Message type is required');
    return;
  }
  
  logger.debug('Received message', { sessionId: session.id, type, payload: message });
  
  const handler = messageHandlers[type];
  
  if (!handler) {
    session.sendError('error', `Unknown message type: ${type}`);
    return;
  }
  
  try {
    await handler(session, message);
  } catch (error) {
    logger.error('Handler error', { type, error: error.message, stack: error.stack });
    session.sendError(type, `Internal error: ${error.message}`, message.requestId);
  }
}

/**
 * Create and start the WebSocket server
 */
async function startServer() {
  // Check ADB availability
  const adbCheck = await adb.checkAdbAvailable();
  if (!adbCheck.available) {
    logger.error('ADB is not available. Please ensure ADB is installed and in PATH.');
    process.exit(1);
  }
  logger.info(`ADB version: ${adbCheck.version}`);
  
  // Check emulator availability (optional)
  const emulatorCheck = await emulator.checkEmulatorAvailable();
  if (!emulatorCheck.available) {
    logger.info('Emulator command not available. Emulator start/stop features will be disabled.');
  }
  
  // Create HTTP server (for REST endpoints and health checks)
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    } else if (req.url === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        sessions: sessionManager.getStats(),
        emulators: emulatorManager.getStats()
      }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
  
  // Create WebSocket server
  const wss = new WebSocket.Server({ server });

  // Set up session removal callback for cleanup
  sessionManager.onSessionRemove(async (sessionId, session, options) => {
    // Clean up stream resources if active
    if (session.streamState && session.streamState !== 'idle') {
      logger.info(`Session removal - cleaning up stream`, { sessionId, streamState: session.streamState });
      streamManager.stopStream(sessionId);
      webrtcSignaling.closeSession(sessionId);
    }

    // Clean up emulator if owned by session
    if (session.ownsEmulator && session.deviceId) {
      const killEmulator = options.killEmulator !== false && KILL_EMULATOR_ON_DISCONNECT;
      
      logger.info(`Session removal - cleaning up emulator`, {
        sessionId,
        deviceId: session.deviceId,
        killEmulator
      });

      await emulatorManager.handleSessionDisconnect(sessionId, killEmulator);
    }
  });
  
  // Handle new connections
  wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    const session = sessionManager.createSession(ws);
    
    logger.info('Client connected', { sessionId: session.id, ip: clientIp });
    
    // Send session info to client
    session.sendSuccess('connected', {
      session_id: session.id,
      message: 'Connected to Android Emulator Control Server'
    });
    
    // Set up heartbeat
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    
    // Serialize message handling so ICE/answer cannot race with in-flight start_stream.
    let messageChain = Promise.resolve();
    ws.on('message', (data) => {
      const raw = data.toString();
      messageChain = messageChain
        .then(() => handleMessage(session, raw))
        .catch((error) => {
          logger.error('Message handling error', { sessionId: session.id, error: error.message });
          session.sendError('error', 'Internal server error');
        });
    });
    
    // Handle close
    ws.on('close', async (code, reason) => {
      logger.info('Client disconnected', {
        sessionId: session.id,
        code,
        reason: reason?.toString() || '',
        hadDevice: !!session.deviceId,
        ownedEmulator: session.ownsEmulator,
        streamState: session.streamState
      });
      
      await sessionManager.removeSession(session.id, {
        killEmulator: KILL_EMULATOR_ON_DISCONNECT
      });
    });
    
    // Handle errors
    ws.on('error', (error) => {
      logger.error('WebSocket error', { sessionId: session.id, error: error.message });
    });
  });
  
  // Heartbeat interval to detect dead connections
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach(async (ws) => {
      if (ws.isAlive === false) {
        const session = sessionManager.getSessionByWs(ws);
        if (session) {
          logger.info('Terminating inactive connection', { 
            sessionId: session.id,
            hadDevice: !!session.deviceId 
          });
          await sessionManager.removeSession(session.id, {
            killEmulator: KILL_EMULATOR_ON_DISCONNECT
          });
        }
        return ws.terminate();
      }
      
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);
  
  // Session cleanup interval
  const cleanupInterval = setInterval(() => {
    sessionManager.cleanupStaleSessions();
  }, SESSION_CLEANUP_INTERVAL);
  
  // Handle server errors
  wss.on('error', (error) => {
    logger.error('WebSocket server error', { error: error.message });
  });
  
  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down server...');
    
    clearInterval(heartbeatInterval);
    clearInterval(cleanupInterval);
    
    // Close all WebSocket connections
    wss.clients.forEach((ws) => {
      ws.close(1001, 'Server shutting down');
    });
    
    // Stop all emulators started by this server
    logger.info('Stopping emulators...');
    await emulator.stopAllEmulators();
    
    wss.close(() => {
      server.close(() => {
        logger.info('Server shut down complete');
        process.exit(0);
      });
    });
    
    // Force exit after timeout
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  
  // Start server
  server.listen(PORT, HOST, () => {
    logger.info(`Server started`, { host: HOST, port: PORT });
    logger.info(`WebSocket endpoint: ws://${HOST}:${PORT}`);
    logger.info(`Health check: http://${HOST}:${PORT}/health`);
    logger.info('Stream — server WebRTC (werift) + adb screenrecord', {
      resolution: `${streamConfig.width}x${streamConfig.height}`,
      fps: streamConfig.fps,
      codec: 'H264'
    });
  });
  
  return { server, wss };
}

// Log async faults instead of exiting silently (keeps WS clients connected when possible)
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('Unhandled promise rejection', { error: err.message, stack: err.stack });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
});

// Start the server
startServer().catch((error) => {
  logger.error('Failed to start server', { error: error.message });
  process.exit(1);
});

module.exports = { startServer };
