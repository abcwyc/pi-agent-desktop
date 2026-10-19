import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createJiti } from 'jiti';
const { AgentSessionWrapper } = await createJiti(import.meta.url, { tsconfigPaths: true }).import('./rpc-manager.ts');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
function session(t) {
  const listeners = new Set(), calls = [], events = [];
  let active = true, resolvePrompt;
  const inner = {
    sessionId: randomUUID(), sessionFile: '', agent: { state: {} },
    get isStreaming() { return active; }, get isIdle() { return !active; },
    isBashRunning: false, isCompacting: false, extensionRunner: {},
    sessionManager: { getCwd: () => '/fixture' }, settingsManager: { getDefaultTools: () => [] },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, dispose() {},
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    async prompt(message, options) {
      calls.push({ message, options });
      if (message === 'reject') throw new Error('Rejected in preflight');
      options.preflightResult(active ? 'queued' : 'started');
      if (active) return;
      active = true; inner.emit({ type: 'agent_start' });
      return new Promise(resolve => { resolvePrompt = resolve; });
    },
    async abort() { inner.finish(); },
    emit(event) { listeners.forEach(fn => fn(event)); },
    finish() {
      inner.emit({ type: 'agent_end' }); active = false;
      inner.emit({ type: 'agent_settled' }); resolvePrompt?.(); resolvePrompt = undefined;
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onEvent(event => events.push(event)); wrapper.start();
  t.after(() => { inner.finish(); wrapper.destroy(); });
  return { inner, wrapper, calls, events };
}
test('RPC outbox items remain editable during streaming and drain through prompt admission after idle', async t => {
  const f = session(t);
  const first = await f.wrapper.send({ type: 'queue_composer', message: 'first' });
  await f.wrapper.send({ type: 'queue_composer', message: 'second' });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.wrapper.send({ type: 'get_state' })).queuedMessages.pending.length, 2);
  assert.equal((await f.wrapper.send({ type: 'take_composer_message', id: first.id })).item.message, 'first');
  f.inner.finish(); await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].message, 'second');
  assert.equal(f.calls[0].options.streamingBehavior, 'followUp');
  assert.ok(f.events.some(e => e.type === 'composer_queue_update' && e.items.length === 2));
});
test('RPC immediately promotes one queued item without clearing other SDK queues or replaying it', async t => {
  const f = session(t), image = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
  const first = await f.wrapper.send({ type: 'queue_composer', message: 'first', images: [image] });
  await f.wrapper.send({ type: 'queue_composer', message: 'keep' });
  await f.wrapper.send({ type: 'send_composer_message', id: first.id });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.streamingBehavior, 'steer');
  assert.deepEqual(f.calls[0].options.images, [image]);
  await f.wrapper.send({ type: 'send_composer_message', id: first.id });
  assert.equal(f.calls.length, 1, 'stale immediate-send must be a no-op');
  assert.deepEqual((await f.wrapper.send({ type: 'get_state' })).queuedMessages.pending.map(i => i.message), ['keep']);
});
test('Stop does not automatically start the queued next task', async t => {
  const f = session(t);
  const item = await f.wrapper.send({ type: 'queue_composer', message: 'keep pending' });
  await f.wrapper.send({ type: 'abort' }); await tick();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.wrapper.send({ type: 'take_composer_message', id: item.id })).item.message, 'keep pending');
});
test('rejected automatic delivery remains in the outbox and reports the error', async t => {
  const f = session(t);
  await f.wrapper.send({ type: 'queue_composer', message: 'reject' });
  f.inner.finish(); await tick();
  assert.equal((await f.wrapper.send({ type: 'get_state' })).queuedMessages.pending[0].message, 'reject');
  assert.equal(f.events.filter(e => e.type === 'prompt_error').length, 1);
});

test('automatic delivery winning against a click returns a harmless synchronized result', async t => {
  const f = session(t);
  const first = await f.wrapper.send({ type: 'queue_composer', message: 'automatically sent' });
  const before = (await f.wrapper.send({ type: 'get_state' })).queuedMessages.pendingVersion;
  f.inner.finish(); await tick();
  const sent = await f.wrapper.send({ type: 'send_composer_message', id: first.id });
  const edited = await f.wrapper.send({ type: 'take_composer_message', id: first.id });
  assert.equal(sent.item, null); assert.equal(edited.item, null);
  assert.equal(edited.pending.length, 0);
  assert.ok(edited.pendingVersion > before);
  assert.equal(f.calls.length, 1);
});
