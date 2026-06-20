'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { CaptureSupervisor } = require('../CaptureSupervisor');

/** Fake capture stream with scripted behaviour. */
class FakeCapture extends EventEmitter {
  constructor(id, behaviour) {
    super();
    this.providerId = id;
    this._behaviour = behaviour; // 'data' | 'ended' | 'timeout'
    this._stopped = false;
  }
  async start() {
    if (this._behaviour === 'ended') {
      setImmediate(() => this.emit('ended', { reason: 'boom' }));
    } else if (this._behaviour === 'data') {
      setImmediate(() => {
        this.emit('streamMeta', { provider: this.providerId });
        this.emit('data', Buffer.from([1, 2, 3]));
        this.emit('data', Buffer.from([4, 5, 6]));
      });
    }
    return { success: true };
  }
  stop() { this._stopped = true; }
  getStatus() { return { providerId: this.providerId, running: !this._stopped }; }
  getStreamMeta() { return { provider: this.providerId }; }
}

function fakeProvider(id, behaviour) {
  return { providerId: id, async startCapture() { return new FakeCapture(id, behaviour); } };
}

test('selects first provider that produces a first frame', async () => {
  const sup = new CaptureSupervisor({ firstFrameTimeoutMs: 500 });
  const res = await sup.selectAndStart({
    chain: [fakeProvider('primary', 'data'), fakeProvider('fallback', 'data')],
    handle: { ref: { id: 'x' } },
    captureOpts: {}
  });
  assert.equal(res.providerId, 'primary');
  assert.equal(res.bufferedChunks.length, 2);
  assert.equal(res.streamMeta.provider, 'primary');
  // StreamManager wires its own 'data' consumer then detaches this listener and
  // replays bufferedChunks manually, so it MUST be exposed as a function.
  assert.equal(typeof res.bufferListener, 'function');
});

test('manual adopt (StreamManager path): detach bufferListener + replay, no dup', async () => {
  const sup = new CaptureSupervisor({ firstFrameTimeoutMs: 500 });
  const res = await sup.selectAndStart({
    chain: [fakeProvider('primary', 'data')],
    handle: { ref: { id: 'x' } },
    captureOpts: {}
  });

  // Mirror StreamManager: attach the live consumer first (via _wireCaptureEvents),
  // then synchronously detach the supervisor's buffer listener and replay.
  const seen = [];
  res.capture.on('data', (chunk) => seen.push(chunk.length));
  res.capture.removeListener('data', res.bufferListener);
  for (const chunk of res.bufferedChunks) seen.push(chunk.length);

  assert.deepEqual(seen, [3, 3]);

  // A subsequent live chunk reaches only the consumer (buffer detached).
  res.capture.emit('data', Buffer.from([9]));
  assert.deepEqual(seen, [3, 3, 1]);
});

test('fails over when primary ends before first frame', async () => {
  const sup = new CaptureSupervisor({ firstFrameTimeoutMs: 500 });
  const res = await sup.selectAndStart({
    chain: [fakeProvider('primary', 'ended'), fakeProvider('fallback', 'data')],
    handle: { ref: { id: 'x' } },
    captureOpts: {}
  });
  assert.equal(res.providerId, 'fallback');
  assert.equal(res.bufferedChunks.length, 2);
});

test('fails over on first-frame timeout', async () => {
  const sup = new CaptureSupervisor({ firstFrameTimeoutMs: 80 });
  const res = await sup.selectAndStart({
    chain: [fakeProvider('primary', 'timeout'), fakeProvider('fallback', 'data')],
    handle: { ref: { id: 'x' } },
    captureOpts: {}
  });
  assert.equal(res.providerId, 'fallback');
});

test('throws when every provider fails', async () => {
  const sup = new CaptureSupervisor({ firstFrameTimeoutMs: 60 });
  await assert.rejects(
    sup.selectAndStart({
      chain: [fakeProvider('a', 'ended'), fakeProvider('b', 'timeout')],
      handle: { ref: { id: 'x' } },
      captureOpts: {}
    }),
    /All capture providers failed startup/
  );
});

test('adopt() replays buffered frames once with no duplicates', async () => {
  const sup = new CaptureSupervisor({ firstFrameTimeoutMs: 500 });
  const res = await sup.selectAndStart({
    chain: [fakeProvider('primary', 'data')],
    handle: { ref: { id: 'x' } },
    captureOpts: {}
  });

  const seen = [];
  res.adopt((chunk) => seen.push(chunk.length));
  // The two buffered chunks are replayed exactly once.
  assert.deepEqual(seen, [3, 3]);

  // A subsequent live chunk reaches the adopted consumer, not the buffer.
  res.capture.emit('data', Buffer.from([9]));
  assert.deepEqual(seen, [3, 3, 1]);
});
