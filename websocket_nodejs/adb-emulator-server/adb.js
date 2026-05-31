/**
 * ADB Wrapper Module
 * Provides async functions for interacting with Android Debug Bridge (ADB)
 */

const { exec, spawn } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// Configuration
const ADB_PATH = process.env.ADB_PATH || 'adb';
const COMMAND_TIMEOUT = parseInt(process.env.ADB_TIMEOUT, 10) || 30000;

/**
 * Logger utility for consistent logging format
 */
const logger = {
  info: (message, data = {}) => {
    console.log(`[ADB][INFO] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
  },
  error: (message, data = {}) => {
    console.error(`[ADB][ERROR] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
  },
  debug: (message, data = {}) => {
    if (process.env.DEBUG === 'true') {
      console.log(`[ADB][DEBUG] ${new Date().toISOString()} - ${message}`, Object.keys(data).length ? data : '');
    }
  }
};

/**
 * Execute an ADB command and return the result
 * @param {string} command - The ADB command to execute (without 'adb' prefix)
 * @param {object} options - Execution options
 * @returns {Promise<{success: boolean, output: string, error?: string}>}
 */
async function executeCommand(command, options = {}) {
  const { timeout = COMMAND_TIMEOUT } = options;
  const fullCommand = `${ADB_PATH} ${command}`;
  
  logger.debug(`Executing command: ${fullCommand}`);
  
  try {
    const { stdout, stderr } = await execAsync(fullCommand, { 
      timeout,
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });
    
    if (stderr && !stderr.includes('daemon')) {
      logger.debug('Command stderr output', { stderr: stderr.trim() });
    }
    
    return {
      success: true,
      output: stdout.trim()
    };
  } catch (error) {
    logger.error('Command execution failed', { 
      command: fullCommand, 
      error: error.message 
    });
    
    return {
      success: false,
      output: '',
      error: error.message
    };
  }
}

/**
 * Get list of connected devices
 * @returns {Promise<{success: boolean, devices: Array<{device_id: string, status: string}>, error?: string}>}
 */
async function getDevices() {
  logger.info('Fetching connected devices');
  
  const result = await executeCommand('devices');
  
  if (!result.success) {
    logger.error('Failed to get devices', { error: result.error });
    return { success: false, devices: [], error: result.error };
  }
  
  const lines = result.output.split('\n').slice(1); // Skip header line
  const devices = lines
    .filter(line => line.trim())
    .map(line => {
      const [deviceId, rawStatus] = line.split('\t');
      // Map ADB status to more readable format
      const status = mapDeviceStatus(rawStatus?.trim());
      return { device_id: deviceId.trim(), status };
    });
  
  logger.info(`Found ${devices.length} device(s)`, { devices });
  
  return { success: true, devices };
}

/**
 * Map ADB device status to readable format
 * @param {string} rawStatus - Raw status from adb devices
 * @returns {string} - Mapped status
 */
function mapDeviceStatus(rawStatus) {
  const statusMap = {
    'device': 'online',
    'offline': 'offline',
    'unauthorized': 'unauthorized',
    'no permissions': 'no_permissions',
    'bootloader': 'bootloader',
    'recovery': 'recovery',
    'sideload': 'sideload'
  };
  return statusMap[rawStatus] || rawStatus || 'unknown';
}

/**
 * Get list of available Android Virtual Devices (emulators)
 * @returns {Promise<{success: boolean, emulators: Array<{name: string}>, error?: string}>}
 */
async function getAvailableEmulators() {
  const emulatorPath = process.env.EMULATOR_PATH || 'emulator';
  
  logger.info('Fetching available AVDs');
  
  try {
    const { stdout, stderr } = await execAsync(`${emulatorPath} -list-avds`, {
      timeout: COMMAND_TIMEOUT
    });
    
    if (stderr && !stderr.includes('WARNING')) {
      logger.debug('Emulator command stderr', { stderr: stderr.trim() });
    }
    
    const emulators = stdout
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
      })
      .map(name => ({ name }));
    
    logger.info(`Found ${emulators.length} AVD(s)`, { emulators });
    
    return { success: true, emulators };
  } catch (error) {
    logger.error('Failed to list AVDs', { error: error.message });
    
    // Check if emulator command is not found
    if (error.message.includes('not found') || error.message.includes('ENOENT')) {
      return {
        success: false,
        emulators: [],
        error: 'Emulator command not found. Ensure Android SDK emulator is installed and in PATH.'
      };
    }
    
    return {
      success: false,
      emulators: [],
      error: error.message
    };
  }
}

/**
 * Execute a shell command on a specific device
 * @param {string} deviceId - The device ID to target
 * @param {string} shellCommand - The shell command to execute
 * @returns {Promise<{success: boolean, output: string, error?: string}>}
 */
async function shellCommand(deviceId, shellCommand) {
  if (!deviceId) {
    return { success: false, output: '', error: 'Device ID is required' };
  }
  
  if (!shellCommand) {
    return { success: false, output: '', error: 'Shell command is required' };
  }
  
  // Sanitize command to prevent injection
  const sanitizedCommand = sanitizeCommand(shellCommand);
  
  logger.info(`Executing shell command on device ${deviceId}`, { command: sanitizedCommand });
  
  return await executeCommand(`-s ${deviceId} ${sanitizedCommand}`);
}

/**
 * Execute any ADB command on a specific device
 * @param {string} deviceId - The device ID to target
 * @param {string} adbCommand - The ADB command to execute
 * @returns {Promise<{success: boolean, output: string, error?: string}>}
 */
async function deviceCommand(deviceId, adbCommand) {
  if (!deviceId) {
    return { success: false, output: '', error: 'Device ID is required' };
  }
  
  if (!adbCommand) {
    return { success: false, output: '', error: 'ADB command is required' };
  }
  
  logger.info(`Executing ADB command on device ${deviceId}`, { command: adbCommand });
  
  return await executeCommand(`-s ${deviceId} ${adbCommand}`);
}

/**
 * Install an APK on a specific device
 * @param {string} deviceId - The device ID to target
 * @param {string} apkPath - Path to the APK file
 * @returns {Promise<{success: boolean, output: string, error?: string}>}
 */
async function installApk(deviceId, apkPath) {
  logger.info(`Installing APK on device ${deviceId}`, { apkPath });
  
  return await executeCommand(`-s ${deviceId} install -r "${apkPath}"`, { 
    timeout: 120000 // 2 minutes for APK install
  });
}

/**
 * Take a screenshot from a specific device
 * @param {string} deviceId - The device ID to target
 * @param {string} localPath - Local path to save the screenshot
 * @returns {Promise<{success: boolean, output: string, error?: string}>}
 */
async function takeScreenshot(deviceId, localPath) {
  logger.info(`Taking screenshot from device ${deviceId}`);
  
  const remotePath = '/sdcard/screenshot.png';
  
  // Capture screenshot on device
  const captureResult = await executeCommand(`-s ${deviceId} shell screencap -p ${remotePath}`);
  if (!captureResult.success) {
    return captureResult;
  }
  
  // Pull screenshot to local
  const pullResult = await executeCommand(`-s ${deviceId} pull ${remotePath} "${localPath}"`);
  if (!pullResult.success) {
    return pullResult;
  }
  
  // Clean up remote file
  await executeCommand(`-s ${deviceId} shell rm ${remotePath}`);
  
  return { success: true, output: localPath };
}

/**
 * Reboot a specific device
 * @param {string} deviceId - The device ID to target
 * @param {string} mode - Reboot mode: 'system', 'bootloader', or 'recovery'
 * @returns {Promise<{success: boolean, output: string, error?: string}>}
 */
async function rebootDevice(deviceId, mode = 'system') {
  const validModes = ['system', 'bootloader', 'recovery'];
  
  if (!validModes.includes(mode)) {
    return { success: false, output: '', error: `Invalid reboot mode. Valid modes: ${validModes.join(', ')}` };
  }
  
  logger.info(`Rebooting device ${deviceId}`, { mode });
  
  const command = mode === 'system' ? 'reboot' : `reboot ${mode}`;
  return await executeCommand(`-s ${deviceId} ${command}`);
}

/**
 * Check if ADB is available on the system
 * @returns {Promise<{available: boolean, version?: string, error?: string}>}
 */
async function checkAdbAvailable() {
  const result = await executeCommand('version');
  
  if (!result.success) {
    return { available: false, error: result.error };
  }
  
  const versionMatch = result.output.match(/Android Debug Bridge version ([\d.]+)/);
  const version = versionMatch ? versionMatch[1] : 'unknown';
  
  logger.info('ADB is available', { version });
  
  return { available: true, version };
}

/**
 * Wait for a device to be connected
 * @param {number} timeout - Maximum time to wait in milliseconds
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function waitForDevice(timeout = 60000) {
  logger.info(`Waiting for device connection (timeout: ${timeout}ms)`);
  
  return await executeCommand('wait-for-device', { timeout });
}

/**
 * Sanitize shell command to prevent injection
 * @param {string} command - The command to sanitize
 * @returns {string} - Sanitized command
 */
function sanitizeCommand(command) {
  // Block dangerous patterns
  const dangerousPatterns = [
    /;\s*rm\s+-rf/i,
    /&&\s*rm\s+-rf/i,
    /\|\s*rm\s+-rf/i,
    /`.*`/,  // Backtick command substitution
    /\$\(.*\)/  // $() command substitution
  ];
  
  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      logger.error('Potentially dangerous command blocked', { command });
      throw new Error('Command contains potentially dangerous patterns');
    }
  }
  
  return command;
}

/**
 * Stream long-running ADB command output
 * @param {string} deviceId - The device ID to target
 * @param {string} command - The ADB command to execute
 * @param {function} onData - Callback for data events
 * @param {function} onError - Callback for error events
 * @returns {ChildProcess} - The spawned process
 */
function streamCommand(deviceId, command, onData, onError) {
  const args = deviceId ? ['-s', deviceId, ...command.split(' ')] : command.split(' ');
  
  logger.info('Starting streaming command', { deviceId, command });
  
  const process = spawn(ADB_PATH, args);
  
  process.stdout.on('data', (data) => {
    if (onData) onData(data.toString());
  });
  
  process.stderr.on('data', (data) => {
    if (onError) onError(data.toString());
  });
  
  process.on('error', (error) => {
    logger.error('Streaming command error', { error: error.message });
    if (onError) onError(error.message);
  });
  
  return process;
}

module.exports = {
  executeCommand,
  getDevices,
  getAvailableEmulators,
  shellCommand,
  deviceCommand,
  installApk,
  takeScreenshot,
  rebootDevice,
  checkAdbAvailable,
  waitForDevice,
  streamCommand,
  logger
};
