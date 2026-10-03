import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

// An extension command's ctx.newSession / fork / switchSession used to be stubs that
// answered { cancelled: true }, so commands built on them silently did nothing in Pi Web.

function persistedSession(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-web-ext-session-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
  const userId = sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
  const assistantId = sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  return { root, sessionManager, userId, assistantId };
}

async function boundWrapper(t, sessionManager, extensionRunner = {}) {
  let actions;
  const inner = {
    sessionId: sessionManager.getSessionId(),
    sessionFile: sessionManager.getSessionFile(),
    isBashRunning: false,
    isStreaming: false,
    extensionRunner,
    sessionManager,
    systemPrompt: "",
    agent: { state: {} },
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    bindExtensions: async (bindings) => { actions = bindings.commandContextActions; },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  return { actions, events };
}

test("ctx.fork writes the forked session and moves the browser to it", async (t) => {
  const { sessionManager, assistantId } = persistedSession(t);
  const { actions, events } = await boundWrapper(t, sessionManager);

  const result = await actions.fork(assistantId, { position: "at" });

  assert.deepEqual(result, { cancelled: false });
  const replaced = events.filter((event) => event.type === "session_replaced");
  assert.equal(replaced.length, 1);
  assert.notEqual(replaced[0].sessionId, sessionManager.getSessionId());
});

test("ctx.fork before a user message copies only what precedes it", async (t) => {
  const { sessionManager, userId } = persistedSession(t);
  const { actions, events } = await boundWrapper(t, sessionManager);

  await actions.fork(userId);

  const replaced = events.find((event) => event.type === "session_replaced");
  assert.ok(replaced);
  const sessions = await SessionManager.list(sessionManager.getCwd(), sessionManager.getSessionDir());
  const child = sessions.find((info) => info.id === replaced.sessionId);
  assert.ok(child, "the forked session file exists");
  assert.equal(child.messageCount, 0);
});

test("a session_before_fork handler can still cancel ctx.fork", async (t) => {
  const { sessionManager, assistantId } = persistedSession(t);
  const emitted = [];
  const { actions, events } = await boundWrapper(t, sessionManager, {
    hasHandlers: (type) => type === "session_before_fork",
    emit: async (event) => { emitted.push(event); return { cancel: true }; },
  });

  const result = await actions.fork(assistantId, { position: "at" });

  assert.deepEqual(result, { cancelled: true });
  assert.deepEqual(emitted, [{ type: "session_before_fork", entryId: assistantId, position: "at" }]);
  assert.equal(events.some((event) => event.type === "session_replaced"), false);
});

test("ctx.switchSession moves the browser to the session in that file", async (t) => {
  const source = persistedSession(t);
  const target = persistedSession(t);
  const targetFile = target.sessionManager.getSessionFile();
  assert.ok(targetFile && existsSync(targetFile));
  const { actions, events } = await boundWrapper(t, source.sessionManager);

  const result = await actions.switchSession(targetFile);

  assert.deepEqual(result, { cancelled: false });
  assert.deepEqual(
    events.filter((event) => event.type === "session_replaced").map((event) => event.sessionId),
    [target.sessionManager.getSessionId()],
  );
});

test("ctx.switchSession rejects a path that is not a session file", async (t) => {
  const { root, sessionManager } = persistedSession(t);
  const { actions } = await boundWrapper(t, sessionManager);

  await assert.rejects(actions.switchSession(path.join(root, "missing.jsonl")), /Session file not found/);
});
