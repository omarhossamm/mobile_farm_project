/**
 * Pipe streams without crashing on EPIPE when the writable end closes first.
 */

function isBenignPipeError(err) {
  if (!err) return true;
  const code = err.code;
  return code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED';
}

/**
 * @param {import('stream').Readable} readable
 * @param {import('stream').Writable} writable
 * @param {(err: Error) => void} [onUnexpectedError]
 * @returns {() => void} unpipe / detach
 */
function safePipe(readable, writable, onUnexpectedError) {
  const onError = (err) => {
    if (isBenignPipeError(err)) return;
    onUnexpectedError?.(err);
  };

  readable.on('error', onError);
  writable.on('error', onError);
  readable.pipe(writable);

  return () => {
    try {
      readable.unpipe(writable);
    } catch (_) { /* ignore */ }
    readable.removeListener('error', onError);
    writable.removeListener('error', onError);
  };
}

/**
 * Swallow EPIPE on a writable (e.g. FFmpeg stdin) so Node does not crash.
 */
function ignoreStdinPipeErrors(stream, onUnexpectedError) {
  if (!stream) return;
  stream.on('error', (err) => {
    if (!isBenignPipeError(err)) {
      onUnexpectedError?.(err);
    }
  });
}

module.exports = { safePipe, ignoreStdinPipeErrors, isBenignPipeError };
