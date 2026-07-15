/**
 * Shared domain types for the platform host layer.
 * @module platform/types
 */

/** @typedef {'android'|'ios'} PlatformId */

/** @typedef {'emulator'|'physical'|'avd'|'simulator'} TargetClass */

/**
 * @typedef {Object} DeviceCapabilities
 * @property {boolean} canStream
 * @property {boolean} canControl
 * @property {boolean} canLaunchApps
 * @property {string[]} [preferredCaptureProviders]
 * @property {string[]} [preferredControlProviders]
 */

/**
 * @typedef {Object} DeviceRef
 * @property {string} id
 * @property {PlatformId} platform
 * @property {TargetClass} targetClass
 * @property {string} displayName
 * @property {'online'|'offline'|'busy'|'unauthorized'} status
 * @property {DeviceCapabilities} capabilities
 * @property {Record<string, string>} [metadata]
 */

/**
 * @typedef {Object} DeviceHandle
 * @property {DeviceRef} ref
 * @property {string} hostId
 * @property {string} leaseId
 * @property {boolean} ownedBySession
 */

/**
 * @typedef {Object} NormalizedControlEvent
 * @property {'tap'|'swipe'|'key'|'text'} action
 * @property {number} [x]
 * @property {number} [y]
 * @property {number} [x1]
 * @property {number} [y1]
 * @property {number} [x2]
 * @property {number} [y2]
 * @property {number} [durationMs]
 * @property {string} [keyCode]
 * @property {string} [text]
 */

/**
 * @typedef {Object} ControlResult
 * @property {boolean} success
 * @property {string} [error]
 */

const PLATFORMS = Object.freeze({
  ANDROID: 'android',
  IOS: 'ios'
});

const LOCAL_HOST_ID = 'local';

module.exports = {
  PLATFORMS,
  LOCAL_HOST_ID
};
