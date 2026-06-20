'use strict';

const { queryDisplaySize } = require('../capture/android/input');

/**
 * Build stream metadata for the desktop coordinate mapper.
 * @param {object} handle DeviceHandle
 * @param {object} capture Active capture stream
 * @param {string} providerId
 * @returns {Promise<object>}
 */
async function buildStreamMeta(handle, capture, providerId) {
  const meta = {
    provider: providerId,
    coordinate_space: 'device_logical',
    platform: handle?.ref?.platform || 'android',
    target_class: handle?.ref?.targetClass || 'unknown',
    device_logical_width: 0,
    device_logical_height: 0,
    stream_width: 0,
    stream_height: 0,
    cropped: false
  };

  if (capture && typeof capture.getStreamMeta === 'function') {
    const fromCapture = capture.getStreamMeta();
    if (fromCapture) Object.assign(meta, fromCapture);
  }

  const md = handle?.metadata || handle?.ref?.metadata || {};
  const sd = md.screen_dimensions || md.screenDimensions || {};
  if (!meta.device_logical_width) {
    meta.device_logical_width =
      sd.width_points || sd.logical_width || md.logical_width || 0;
  }
  if (!meta.device_logical_height) {
    meta.device_logical_height =
      sd.height_points || sd.logical_height || md.logical_height || 0;
  }

  if (!meta.stream_width && meta.device_logical_width) {
    meta.stream_width = meta.device_logical_width;
  }
  if (!meta.stream_height && meta.device_logical_height) {
    meta.stream_height = meta.device_logical_height;
  }

  const deviceId = handle?.ref?.id;
  const isAndroid = (handle?.ref?.platform || meta.platform) === 'android';
  if (isAndroid && deviceId && (!meta.device_logical_width || !meta.device_logical_height)) {
    const ds = await queryDisplaySize(deviceId);
    meta.device_logical_width = ds.width;
    meta.device_logical_height = ds.height;
    if (!meta.stream_width) meta.stream_width = ds.width;
    if (!meta.stream_height) meta.stream_height = ds.height;
  }

  return meta;
}

module.exports = { buildStreamMeta };
