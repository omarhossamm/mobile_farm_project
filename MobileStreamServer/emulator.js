/**
 * Android Emulator Control Module
 * Provides functions to start, stop, and manage Android emulators
 */

const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const adb = require('./adb');

const execAsync = promisify(exec);

// Configuration
const EMULATOR_PATH = process.env.EMULATOR_PATH || 'emulator';
const EMULATOR_START_TIMEOUT = parseInt(process.env.EMULATOR_START_TIMEOUT, 10) || 120000; // 2 minutes

/**
 * Logger utility for consistent logging format
 */
const logger = {
  info: (message, data = {}) => {
    console.log(`[EMULATOR][INFO] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
  },
  error: (message, data = {}) => {
    console.error(`[EMULATOR][ERROR] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
  },
  debug: (message, data = {}) => {
    if (process.env.DEBUG === 'true') {
      console.log(`[EMULATOR][DEBUG] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
    }
  }
};

// Store for running emulator processes
const runningEmulators = new Map();

/**
 * Get list of available AVDs (Android Virtual Devices)
 * @returns {Promise<{success: boolean, avds: string[], error?: string}>}
 */
async function listAvailableEmulators() {
  logger.info('Fetching available AVDs');
  
  try {
    const { stdout, stderr } = await execAsync(`${EMULATOR_PATH} -list-avds`);
    
    const avds = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => {
        // Filter out empty lines and INFO/WARNING/ERROR messages
        if (line.length === 0) return false;
        if (line.startsWith('INFO')) return false;
        if (line.startsWith('WARNING')) return false;
        if (line.startsWith('ERROR')) return false;
        if (line.includes('crashdata')) return false;
        return true;
      });
    
    logger.info(`Found ${avds.length} available AVD(s)`, { avds });
    
    return { success: true, avds };
  } catch (error) {
    logger.error('Failed to list AVDs', { error: error.message });
    return { success: false, avds: [], error: error.message };
  }
}

/**
 * Start an Android emulator
 * @param {string} emulatorName - Name of the AVD to start
 * @param {object} options - Start options
 * @returns {Promise<{success: boolean, deviceId?: string, pid?: number, error?: string}>}
 */
async function startEmulator(emulatorName, options = {}) {
  const {
    noSnapshot = false,
    wipeData = false,
    noWindow = false,
    gpuMode = 'auto',
    timeout = EMULATOR_START_TIMEOUT
  } = options;
  
  if (!emulatorName) {
    return { success: false, error: 'Emulator name is required' };
  }
  
  logger.info(`Starting emulator: ${emulatorName}`, { options });
  
  // Check if emulator exists
  const availableResult = await listAvailableEmulators();
  if (!availableResult.success) {
    return { success: false, error: availableResult.error };
  }
  
  if (!availableResult.avds.includes(emulatorName)) {
    return { 
      success: false, 
      error: `Emulator "${emulatorName}" not found. Available: ${availableResult.avds.join(', ')}` 
    };
  }
  
  // Build command arguments
  const args = ['-avd', emulatorName, '-gpu', gpuMode];
  
  if (noSnapshot) {
    args.push('-no-snapshot');
  }
  if (wipeData) {
    args.push('-wipe-data');
  }
  if (noWindow) {
    args.push('-no-window');
  }
  
  // Get devices before starting
  const beforeDevices = await adb.getDevices();
  const beforeIds = new Set(beforeDevices.devices.map(d => d.device_id));
  
  // Start emulator process
  return new Promise((resolve) => {
    logger.info(`Spawning emulator process`, { args });
    
    const emulatorProcess = spawn(EMULATOR_PATH, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    const pid = emulatorProcess.pid;
    let deviceId = null;
    let startupError = null;
    
    // Handle process errors
    emulatorProcess.on('error', (error) => {
      logger.error('Emulator process error', { error: error.message });
      startupError = error.message;
    });
    
    // Capture stderr for debugging
    emulatorProcess.stderr.on('data', (data) => {
      const message = data.toString();
      logger.debug('Emulator stderr', { message });
      
      // Check for common errors
      if (message.includes('ERROR') || message.includes('PANIC')) {
        startupError = message.trim();
      }
    });
    
    // Poll for new device
    const pollInterval = 2000; // 2 seconds
    const startTime = Date.now();
    
    const pollForDevice = async () => {
      // Check for startup error
      if (startupError) {
        cleanup();
        resolve({ success: false, error: startupError });
        return;
      }
      
      // Check timeout
      if (Date.now() - startTime > timeout) {
        cleanup();
        resolve({ success: false, error: 'Emulator start timeout exceeded' });
        return;
      }
      
      // Check for new device
      const currentDevices = await adb.getDevices();
      const newDevice = currentDevices.devices.find(
        d => !beforeIds.has(d.device_id) && d.status === 'online'
      );
      
      if (newDevice) {
        deviceId = newDevice.device_id;
        runningEmulators.set(deviceId, { 
          process: emulatorProcess, 
          pid, 
          emulatorName,
          startedAt: new Date().toISOString()
        });
        
        logger.info(`Emulator started successfully`, { deviceId, pid });
        resolve({ success: true, deviceId, pid });
        return;
      }
      
      // Continue polling
      setTimeout(pollForDevice, pollInterval);
    };
    
    const cleanup = () => {
      try {
        emulatorProcess.kill();
      } catch (e) {
        // Ignore
      }
    };
    
    // Start polling after a brief delay
    setTimeout(pollForDevice, pollInterval);
  });
}

/**
 * Stop an Android emulator
 * @param {string} deviceId - The device ID of the emulator to stop
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function stopEmulator(deviceId) {
  if (!deviceId) {
    return { success: false, error: 'Device ID is required' };
  }
  
  logger.info(`Stopping emulator: ${deviceId}`);
  
  // Try graceful shutdown via ADB
  const shutdownResult = await adb.executeCommand(`-s ${deviceId} emu kill`);
  
  // Also try to kill the process if we have it
  const emulatorInfo = runningEmulators.get(deviceId);
  if (emulatorInfo) {
    try {
      emulatorInfo.process.kill('SIGTERM');
    } catch (e) {
      // Process might already be dead
    }
    runningEmulators.delete(deviceId);
  }
  
  if (shutdownResult.success || emulatorInfo) {
    logger.info(`Emulator stopped: ${deviceId}`);
    return { success: true };
  }
  
  return { success: false, error: shutdownResult.error || 'Failed to stop emulator' };
}

/**
 * Stop all running emulators
 * @returns {Promise<{success: boolean, stopped: string[], errors: string[]}>}
 */
async function stopAllEmulators() {
  logger.info('Stopping all emulators');
  
  const devices = await adb.getDevices();
  const emulators = devices.devices.filter(d => d.device_id.startsWith('emulator-'));
  
  const stopped = [];
  const errors = [];
  
  for (const emulator of emulators) {
    const result = await stopEmulator(emulator.device_id);
    if (result.success) {
      stopped.push(emulator.device_id);
    } else {
      errors.push(`${emulator.device_id}: ${result.error}`);
    }
  }
  
  return { success: errors.length === 0, stopped, errors };
}

/**
 * Get status of running emulators
 * @returns {Promise<{emulators: Array<{deviceId: string, status: string, info?: object}>}>}
 */
async function getEmulatorStatus() {
  const devices = await adb.getDevices();
  const emulators = devices.devices.filter(d => d.device_id.startsWith('emulator-'));
  
  const status = emulators.map(device => {
    const info = runningEmulators.get(device.device_id);
    return {
      deviceId: device.device_id,
      status: device.status,
      info: info ? {
        emulatorName: info.emulatorName,
        pid: info.pid,
        startedAt: info.startedAt
      } : null
    };
  });
  
  return { emulators: status };
}

/**
 * Check if emulator command is available
 * @returns {Promise<{available: boolean, error?: string}>}
 */
async function checkEmulatorAvailable() {
  try {
    const { stdout } = await execAsync(`${EMULATOR_PATH} -version`);
    logger.info('Emulator is available');
    return { available: true };
  } catch (error) {
    logger.error('Emulator not available', { error: error.message });
    return { available: false, error: error.message };
  }
}

module.exports = {
  listAvailableEmulators,
  startEmulator,
  stopEmulator,
  stopAllEmulators,
  getEmulatorStatus,
  checkEmulatorAvailable,
  logger
};
