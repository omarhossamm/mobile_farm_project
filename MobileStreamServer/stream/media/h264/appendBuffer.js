/**
 * Efficient carry buffer for H.264 elementary stream chunks (avoids per-chunk Buffer.concat).
 */

function appendChunk(state, chunk) {
  if (!chunk || chunk.length === 0) return;

  if (!state.chunkParts) {
    state.chunkParts = [];
    state.chunkBytes = 0;
  }

  state.chunkParts.push(chunk);
  state.chunkBytes += chunk.length;

  // Flatten when many small adb reads accumulate
  if (state.chunkParts.length >= 16 || state.chunkBytes > 512 * 1024) {
    state.buffer = Buffer.concat(state.chunkParts);
    state.chunkParts = [];
    state.chunkBytes = 0;
  }
}

function flushToBuffer(state) {
  if (state.chunkParts?.length > 0) {
    const tail = Buffer.concat(state.chunkParts);
    state.chunkParts = [];
    state.chunkBytes = 0;
    state.buffer = state.buffer?.length
      ? Buffer.concat([state.buffer, tail])
      : tail;
  }
}

module.exports = { appendChunk, flushToBuffer };
