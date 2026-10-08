import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { getRpcSessionInfos } = await jiti.import("./rpc-manager.ts");

function makeRuntimeSession({ id, filePath, running, entries }) {
  const timestamp = "2026-08-12T01:02:03.000Z";
  const manager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp/runtime-cwd", timestamp }),
    getEntries: () => entries,
    getSessionFile: () => filePath,
    getSessionName: () => undefined,
  };
  return {
    isAlive: () => true,
    isRunning: () => running,
    inner: { sessionManager: manager },
    get sessionId() { return id; },
    get sessionFile() { return filePath; },
    get cwd() { return "/tmp/runtime-cwd"; },
  };
}

test("lists an accepted new prompt before its session file exists", (t) => {
  const previousRegistry = globalThis.__piSessions;
  const timestamp = "2026-08-12T01:02:04.000Z";
  const visible = makeRuntimeSession({
    id: "visible-runtime",
    filePath: join(tmpdir(), "pi-web-missing-runtime-session.jsonl"),
    running: true,
    entries: [{
      type: "message",
      id: "u1",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text: "first" }, { type: "text", text: "prompt" }],
      },
    }],
  });
  const emptyEnsureSession = makeRuntimeSession({
    id: "empty-runtime",
    filePath: join(tmpdir(), "pi-web-missing-empty-session.jsonl"),
    running: false,
    entries: [],
  });
  globalThis.__piSessions = new Map([
    ["visible-runtime", visible],
    ["empty-runtime", emptyEnsureSession],
  ]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const infos = getRpcSessionInfos();

  assert.equal(infos.length, 1);
  assert.equal(infos[0].id, "visible-runtime");
  assert.equal(infos[0].firstMessage, "first prompt");
  assert.equal(infos[0].messageCount, 1);
  assert.equal(infos[0].transient, true);
});

test("keeps an idle runtime visible once its JSONL file exists", (t) => {
  const previousRegistry = globalThis.__piSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-runtime-session-"));
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, "persisted\n");
  globalThis.__piSessions = new Map([["persisted-runtime", makeRuntimeSession({
    id: "persisted-runtime",
    filePath,
    running: false,
    entries: [],
  })]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
    rmSync(dir, { recursive: true, force: true });
  });

  const infos = getRpcSessionInfos();

  assert.equal(infos.length, 1);
  assert.equal(infos[0].transient, false);
});

const { AgentSessionWrapper, subscribeRunningSessions, notifyRunningChange } = await jiti.import("./rpc-manager.ts");
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function pendingRuntime(t, { prompt, mcpHost } = {}) {
  const previous = globalThis.__piSessions;
  const id = "pending-preview";
  const stub = makeRuntimeSession({ id, filePath: join(tmpdir(), "pi-missing-preview.jsonl"), running: false, entries: [] });
  const inner = {
    sessionId: id, sessionFile: stub.sessionFile,
    sessionManager: { ...stub.inner.sessionManager, getCwd: () => "/tmp/runtime-cwd" },
    isStreaming: false, isIdle: true, isCompacting: false, isBashRunning: false,
    agent: { state: {} }, settingsManager: { getDefaultTools: () => [] },
    prompt: prompt ?? (async () => {}), dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner, { mcpHost });
  globalThis.__piSessions = new Map([[id, wrapper]]);
  const windows = [[], []];
  const unsubscribes = windows.map((frames) => subscribeRunningSessions(() => frames.push(getRpcSessionInfos())));
  t.after(() => {
    unsubscribes.forEach((unsubscribe) => unsubscribe());
    wrapper.destroy();
    globalThis.__piSessions = previous;
  });
  return { wrapper, inner, windows };
}

test("both windows see the submitted text before MCP or SDK preflight finishes", async (t) => {
  const mcp = deferred(), preflight = deferred();
  let sdkCalled = false;
  const { wrapper, windows } = pendingRuntime(t, {
    mcpHost: { prepareForPrompt: () => mcp.promise, dispose() {} },
    prompt: async () => { sdkCalled = true; await preflight.promise; },
  });
  assert.deepEqual(getRpcSessionInfos(), [], "composer warm-up must stay hidden");
  const sending = wrapper.send({ type: "prompt", message: "show this now" });
  await tick();
  assert.equal(sdkCalled, false);
  for (const frames of windows) {
    assert.equal(frames.at(-1)[0].firstMessage, "show this now");
    assert.equal(frames.at(-1)[0].transient, true);
    assert.equal(frames.at(-1)[0].messageCount, 0, "preview must not invent persisted messages");
  }
  mcp.resolve();
  await tick();
  assert.equal(sdkCalled, true);
  assert.equal(getRpcSessionInfos()[0].firstMessage, "show this now");
  preflight.resolve();
  await sending;
  assert.deepEqual(getRpcSessionInfos(), [], "handled commands without history must not leave ghost rows");
  for (const frames of windows) assert.deepEqual(frames.at(-1), []);
});

for (const synchronous of [false, true]) {
  test(`preflight rejection clears its preview (${synchronous ? "sync" : "async"})`, async (t) => {
    const failure = new Error("rejected");
    const gate = deferred();
    const { wrapper, windows } = pendingRuntime(t, {
      prompt: synchronous ? () => { throw failure; } : () => gate.promise,
    });
    const sending = wrapper.send({ type: "prompt", message: "rejected prompt" });
    const rejected = assert.rejects(sending, /rejected/);
    if (!synchronous) {
      await tick();
      assert.equal(getRpcSessionInfos()[0].firstMessage, "rejected prompt");
      gate.reject(failure);
    }
    await rejected;
    assert.equal(wrapper.getPendingPromptPreview(), null);
    assert.deepEqual(getRpcSessionInfos(), []);
    for (const frames of windows) assert.deepEqual(frames.at(-1), []);
  });
}

test("stopping during MCP preparation removes the preview before any SDK message", async (t) => {
  const { wrapper, inner } = pendingRuntime(t, {
    mcpHost: {
      prepareForPrompt: (signal) => new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
      dispose() {},
    },
  });
  inner.abort = async () => {};
  const sending = wrapper.send({ type: "prompt", message: "stop me" });
  const rejected = assert.rejects(sending);
  await tick();
  assert.equal(getRpcSessionInfos().length, 1);
  await wrapper.send({ type: "abort" });
  await rejected;
  assert.equal(wrapper.getPendingPromptPreview(), null);
  assert.deepEqual(getRpcSessionInfos(), []);
});

test("list changes notify both windows even when running ids are unchanged", async (t) => {
  const gate = deferred();
  const { wrapper, inner, windows } = pendingRuntime(t, { prompt: () => gate.promise });
  const sending = wrapper.send({ type: "prompt", message: "preview" });
  await tick();
  inner.sessionManager.getSessionName = () => "renamed while running";
  const before = windows.map((frames) => frames.length);
  invalidateSessionListCache();
  notifyRunningChange();
  windows.forEach((frames, i) => {
    assert.equal(frames.length, before[i] + 1);
    assert.equal(frames.at(-1)[0].name, "renamed while running");
  });
  notifyRunningChange();
  windows.forEach((frames, i) => assert.equal(frames.length, before[i] + 1, "identical snapshots stay deduplicated"));
  gate.resolve();
  await sending;
});

test("an image-only prompt is visible before there is a text entry", async (t) => {
  const gate = deferred();
  const { wrapper } = pendingRuntime(t, { prompt: () => gate.promise });
  const sending = wrapper.send({ type: "prompt", message: "", images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] });
  await tick();
  assert.equal(getRpcSessionInfos().length, 1);
  gate.resolve();
  await sending;
});
