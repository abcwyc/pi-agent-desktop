import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Script } from 'node:vm';
import ts from 'typescript';
import { createJiti } from 'jiti';
const { mergeComposerQueueSnapshot } = await createJiti(import.meta.url).import('../lib/composer-queue-types.ts');

const source = ts.createSourceFile('useAgentSession.ts', readFileSync(new URL('./useAgentSession.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
function callback(name, overrides = {}) {
  let node;
  const find = candidate => {
    if (ts.isVariableDeclaration(candidate) && candidate.name.getText(source) === name) node = candidate.initializer.arguments[0];
    ts.forEachChild(candidate, find);
  };
  find(source); assert.ok(node);
  const env = {
    Error, TypeError, mergeComposerQueueSnapshot,
    sessionIdRef: { current: 'session-a' }, sessionGenerationRef: { current: 1 },
    editEntryId: null, composerDraftKey: 'session-a', addNotice() {}, restoreSubmission() {}, setQueuedMessages() {},
    ...overrides,
  };
  return { env, run: new Script(ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText).runInNewContext(env) };
}
test('ordinary streaming send enters the editable outbox with images', async () => {
  const calls = [];
  const { run } = callback('handleFollowUp', { sendAgentCommand: async (sid, body) => calls.push({ sid, body }) });
  await run('later', [{ data: 'aGVsbG8=', mimeType: 'image/png' }]);
  assert.equal(calls[0].sid, 'session-a');
  assert.equal(calls[0].body.type, 'queue_composer');
  assert.equal(calls[0].body.images[0].type, 'image');
  assert.equal(calls[0].body.message, 'later');
});
test('editing merges the claimed server content back into the original session draft', async () => {
  const restores = [];
  let state = { steering: ['extension'], followUp: [], pending: [{ id: 'first' }, { id: 'second' }] };
  const { run } = callback('handleQueuedMessageAction', {
    sendAgentCommand: async () => ({ item: { id: 'first', message: 'original', images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }] }, pending: [{ id: 'second' }], pendingVersion: 3 }),
    restoreSubmission: (...args) => restores.push(args), setQueuedMessages: update => { state = update(state); },
  });
  await run('first', 'edit');
  assert.equal(restores[0][0], 'original'); assert.equal(restores[0][2], 'session-a');
  assert.equal(restores[0][1][0].data, 'aGVsbG8=');
  assert.equal(state.pending.length, 1); assert.equal(state.pending[0].id, 'second');
  assert.equal(state.steering[0], 'extension');
});
test('an edit response arriving after a session switch restores A without changing B queue', async () => {
  let resolve;
  const restores = [];
  const { env, run } = callback('handleQueuedMessageAction', {
    sendAgentCommand: () => new Promise(done => { resolve = done; }),
    restoreSubmission: (...args) => restores.push(args),
    setQueuedMessages: () => assert.fail('must not change next session'),
  });
  const pending = run('first', 'edit');
  env.sessionIdRef.current = 'session-b'; env.sessionGenerationRef.current++;
  resolve({ item: { id: 'first', message: 'restore to A' }, pending: [], pendingVersion: 2 }); await pending;
  assert.equal(restores[0][2], 'session-a');
});
test('an explicit queue rejection restores the submission; an ambiguous transport error does not duplicate it', async () => {
  for (const error of [Object.assign(new Error('rejected'), { status: 500 }), new TypeError('network lost')]) {
    const restores = [], notices = [];
    const { run } = callback('handleFollowUp', {
      sendAgentCommand: async () => { throw error; },
      restoreSubmission: (...args) => restores.push(args), addNotice: item => notices.push(item),
    });
    await run('recoverable');
    assert.equal(restores.length, 'status' in error ? 1 : 0);
    assert.equal(notices.length, 1);
  }
});
test('send/delete actions never put the message into the editor', async () => {
  for (const action of ['send', 'delete']) {
    const calls = [];
    const { run } = callback('handleQueuedMessageAction', {
      sendAgentCommand: async (sid, body) => { calls.push(body); return { item: { message: 'pending' }, pending: [], pendingVersion: 2 }; },
      restoreSubmission: () => assert.fail('only edit restores'),
    });
    await run('first', action);
    assert.equal(calls[0].type, action === 'send' ? 'send_composer_message' : 'take_composer_message');
  }
});

test('clicking a consumed row synchronizes the outbox without an error or restoring sent text', async () => {
  for (const action of ['edit', 'delete', 'send']) {
    let state = { pending: [{ id: 'consumed' }], pendingVersion: 1 };
    const { run } = callback('handleQueuedMessageAction', {
      sendAgentCommand: async () => ({ item: null, pending: [], pendingVersion: 2 }),
      setQueuedMessages: update => { state = update(state); },
      restoreSubmission: () => assert.fail('consumed text must not be restored'),
      addNotice: () => assert.fail('normal consumption is not an error'),
    });
    await run('consumed', action);
    assert.equal(state.pending.length, 0);
    assert.equal(state.pendingVersion, 2);
  }
});

test('a delayed action response cannot resurrect another message that SSE already consumed', async () => {
  const { run } = callback('handleQueuedMessageAction', {
    sendAgentCommand: async () => ({ item: null, pending: [{ id: 'already-consumed' }], pendingVersion: 2 }),
    setQueuedMessages: update => {
      const next = update({ pending: [], pendingVersion: 3 });
      assert.equal(next.pending.length, 0); assert.equal(next.pendingVersion, 3);
    },
  });
  await run('first', 'send');
});

test('delayed polling snapshots cannot overwrite newer queue events', () => {
  const next = mergeComposerQueueSnapshot({ pending: [], pendingVersion: 5 }, { pending: [{ id: 'old' }], pendingVersion: 4 });
  assert.equal(next.pending.length, 0); assert.equal(next.pendingVersion, 5);
  const added = mergeComposerQueueSnapshot(next, { pending: [{ id: 'new' }], pendingVersion: 6 });
  assert.equal(added.pending[0].id, 'new');
});
