import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createJiti } from 'jiti';
const { ComposerQueue, getPendingComposerMessages } = await createJiti(import.meta.url).import('./composer-queue.ts');
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' };
function fixture(t, overrides = {}) {
  const sent = [], changes = [], failures = [];
  let idle = false;
  const id = randomUUID();
  const queue = new ComposerQueue(id, {
    canDeliver: () => idle,
    deliver: async (item, steer) => { sent.push({ item, steer }); idle = false; },
    changed: items => changes.push(items), failed: error => failures.push(error), ...overrides,
  });
  t.after(() => queue.dispose());
  return { queue, id, sent, changes, failures, finish() { idle = true; queue.wake(); } };
}
test('outbox waits for idle and sends one message per completed run, preserving images', async t => {
  const f = fixture(t);
  f.queue.enqueue('first', [image]);
  f.queue.enqueue('second');
  await tick();
  assert.equal(f.sent.length, 0);
  f.finish(); await tick();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].item.images, [image]);
  assert.equal(f.sent[0].steer, false);
  assert.equal(f.queue.snapshot()[0].message, 'second');
  f.finish(); await tick();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.queue.snapshot(), []);
});
test('individual edit/delete only claim the selected item; identical text has different identity', t => {
  const { queue } = fixture(t);
  const a = queue.enqueue('same', [image]), b = queue.enqueue('same'), c = queue.enqueue('third');
  assert.deepEqual(queue.take(a.id).images, [image]);
  assert.deepEqual(queue.snapshot().map(i => i.id), [b.id, c.id]);
  queue.take(c.id);
  assert.deepEqual(queue.snapshot().map(i => i.id), [b.id]);
  assert.equal(queue.take(a.id), null);
});
test('send now claims exactly once and forwards original attachments as steering', async t => {
  const f = fixture(t), a = f.queue.enqueue('guide', [image]);
  await f.queue.sendNow(a.id);
  await f.queue.sendNow(a.id);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].steer, true);
  assert.deepEqual(f.sent[0].item.images, [image]);
  f.finish(); await tick(); assert.equal(f.sent.length, 1);
});
test('consumed messages cannot be edited, deleted or sent again', async t => {
  const f = fixture(t), a = f.queue.enqueue('queued');
  f.finish(); await tick();
  assert.equal(f.queue.take(a.id), null);
  await f.queue.sendNow(a.id);
  assert.equal(f.sent.length, 1);
});
test('Stop pauses automatic delivery and entries remain editable', async t => {
  const f = fixture(t), a = f.queue.enqueue('keep me');
  f.queue.pause(); f.finish(); await tick();
  assert.equal(f.sent.length, 0);
  assert.equal(f.queue.take(a.id).message, 'keep me');
});
test('preflight rejection preserves the item and pauses instead of retrying indefinitely', async t => {
  const f = fixture(t, { deliver: async () => { throw new Error('No credentials'); } });
  const a = f.queue.enqueue('retry later', [image]);
  f.finish(); await tick(); await tick();
  assert.deepEqual(f.queue.snapshot(), [a]);
  assert.equal(f.failures.length, 1);
  await assert.rejects(f.queue.sendNow(a.id), /No credentials/);
  assert.deepEqual(f.queue.snapshot(), [a]);
});
test('wrapper disposal preserves a paused outbox for reconnect without starting a task', async t => {
  const f = fixture(t), a = f.queue.enqueue('unsent');
  f.queue.pause(); f.queue.dispose();
  const rebound = new ComposerQueue(f.id, { canDeliver: () => true, deliver: async () => assert.fail('paused'), changed() {}, failed() {} });
  t.after(() => rebound.dispose());
  rebound.wake(); await tick();
  assert.deepEqual(getPendingComposerMessages(f.id), [a]);
  assert.equal(rebound.take(a.id).message, 'unsent');
});
test('a stale streaming UI can enqueue into an already idle session without stranding the message', async t => {
  const f = fixture(t);
  f.finish(); f.queue.enqueue('run now that the previous run ended');
  await tick(); assert.equal(f.sent.length, 1);
});
