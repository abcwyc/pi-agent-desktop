import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  IDLE_SESSION_CAP_GRACE_MS,
  IDLE_SESSION_CAP_MAX_BYTES,
  IDLE_SESSION_CAP_MAX_COUNT,
  selectIdleSessionsToEvict,
} = await jiti.import("./idle-session-cap.ts");
const { AgentSessionWrapper, enforceIdleSessionCap } = await jiti.import("./rpc-manager.ts");
const { registerSessionLivenessProvider } = await jiti.import("./session-liveness.ts");

const MB = 1024 * 1024;
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("keeps the most recently left sessions within the count", () => {
  const candidates = Array.from({ length: IDLE_SESSION_CAP_MAX_COUNT + 2 }, (_, i) => ({
    id: `s${i}`, idleSince: i, bytes: 1,
  }));
  assert.deepEqual(selectIdleSessionsToEvict(candidates), ["s0", "s1"]);
});

test("evicts older sessions that would break the byte budget, newest first wins", () => {
  const evict = selectIdleSessionsToEvict([
    { id: "old-big", idleSince: 1, bytes: 135 * MB },
    { id: "small", idleSince: 2, bytes: 1 * MB },
    { id: "new-big", idleSince: 3, bytes: 135 * MB },
  ], { maxBytes: 200 * MB });
  assert.deepEqual(evict, ["old-big"]);
});

test("the newest session is kept even when it alone is over budget", () => {
  assert.deepEqual(selectIdleSessionsToEvict([
    { id: "huge", idleSince: 2, bytes: IDLE_SESSION_CAP_MAX_BYTES * 2 },
    { id: "older", idleSince: 1, bytes: 1 },
  ]), ["older"]);
});

test("nothing to evict under both limits", () => {
  assert.deepEqual(selectIdleSessionsToEvict([]), []);
  assert.deepEqual(selectIdleSessionsToEvict([{ id: "a", idleSince: 1, bytes: 10 }]), []);
});

function makeInner(sessionId, sessionFile) {
  return {
    sessionId,
    sessionFile,
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    isIdle: true,
    extensionRunner: {},
    agent: { state: {} },
    sessionManager: { getCwd: () => tmpdir(), getEntry: () => undefined },
    subscribe: () => () => {},
    dispose() { this.disposed = true; },
  };
}

function withRegistry(t, count, bytesEach = 10) {
  const dir = mkdtempSync(join(tmpdir(), "idle-cap-"));
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map();
  const wrappers = [];
  for (let i = 0; i < count; i += 1) {
    const file = join(dir, `s${i}.jsonl`);
    writeFileSync(file, "x".repeat(bytesEach));
    const wrapper = new AgentSessionWrapper(makeInner(`s${i}`, file));
    globalThis.__piSessions.set(`s${i}`, wrapper);
    wrappers.push(wrapper);
  }
  t.after(() => {
    for (const wrapper of wrappers) wrapper.destroy();
    globalThis.__piSessions = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, wrappers };
}

const later = () => Date.now() + IDLE_SESSION_CAP_GRACE_MS + 1;

test("enforceIdleSessionCap shuts down the oldest unwatched idle sessions beyond the cap", async (t) => {
  const { wrappers } = withRegistry(t, IDLE_SESSION_CAP_MAX_COUNT + 1);
  const evicted = enforceIdleSessionCap(later());
  await nextTurn();
  assert.equal(evicted.length, 1);
  assert.equal(wrappers.filter((w) => !w.isAlive()).length, 1);
  assert.equal(wrappers.filter((w) => w.isAlive()).length, IDLE_SESSION_CAP_MAX_COUNT);
});

test("running, watched, liveness-held and fileless sessions are never capped", async (t) => {
  const { wrappers } = withRegistry(t, IDLE_SESSION_CAP_MAX_COUNT + 4);
  const [running, watched, held, fileless] = wrappers;
  running.inner.isIdle = false; // mid auto-retry: isRunning() must hold it
  const unsubscribe = watched.onEvent(() => {});
  t.after(unsubscribe);
  const release = registerSessionLivenessProvider({ name: "test", sessionId: held.sessionId, isActive: () => true });
  t.after(release);
  fileless.inner.sessionFile = "";

  for (const wrapper of [running, watched, held, fileless]) assert.equal(wrapper.idleCapCandidate(later()), null);
  enforceIdleSessionCap(later());
  await nextTurn();
  for (const wrapper of [running, watched, held, fileless]) assert.equal(wrapper.isAlive(), true);
  // The other IDLE_SESSION_CAP_MAX_COUNT sessions fit exactly.
  assert.equal(wrappers.every((w) => w.isAlive()), true);
});

test("a session within the grace period after losing its listener is not a candidate", (t) => {
  const { wrappers } = withRegistry(t, 1);
  const unsubscribe = wrappers[0].onEvent(() => {});
  unsubscribe();
  assert.equal(wrappers[0].idleCapCandidate(Date.now()), null);
  assert.notEqual(wrappers[0].idleCapCandidate(later()), null);
});

test("losing the last listener notifies the registry once", (t) => {
  const { wrappers } = withRegistry(t, 1);
  let calls = 0;
  wrappers[0].onUnwatched(() => { calls += 1; });
  const a = wrappers[0].onEvent(() => {});
  const b = wrappers[0].onEvent(() => {});
  a();
  assert.equal(calls, 0);
  b();
  b();
  assert.equal(calls, 1);
});
