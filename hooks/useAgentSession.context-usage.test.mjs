import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile(
  "useAgentSession.ts",
  readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
);

function compileHandler(name) {
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, find);
  }
  const handler = find(source);
  assert.ok(handler, `handler ${name} not found`);
  return new Script(ts.transpileModule(handler.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
}

const reconcileScript = compileHandler("reconcileAgentState");
const sessionCommandScript = compileHandler("handleBuiltinSlashCommand");
const oldUsage = { tokens: 50_000, contextWindow: 1_000_000, percent: 5 };
const newUsage = { tokens: 120_000, contextWindow: 1_000_000, percent: 12 };

function harness({ response, stats, pending } = {}) {
  const state = { contextUsage: oldUsage, stats: null, finished: 0, panelsOpened: 0 };
  const refs = {
    sessionIdRef: { current: "session-a" },
    sessionGenerationRef: { current: 1 },
    promptRunIdRef: { current: 1 },
    agentRunningRef: { current: true },
    sdkAgentActiveRef: { current: false },
    rpcPromptPendingRef: { current: false },
  };
  const globals = {
    ...refs,
    fetch: async () => ({ ok: true, json: async () => pending ? await pending : response }),
    sendAgentCommand: async () => pending ? await pending : stats,
    encodeURIComponent,
    syncLiveModel() {},
    setContextUsage(value) { state.contextUsage = value; },
    setSessionStatsOverride(value) { state.stats = value; },
    setIsCompacting() {},
    setQueuedMessages() {},
    normalizeQueuedMessages: (value) => value,
    seedStreamingSnapshot() {},
    setSystemPrompt() {},
    setExtensionStatuses() {},
    setExtensionWidgets() {},
    finishPromptWithoutStream: async () => { state.finished += 1; },
    onSessionStatsPanelOpen: () => { state.panelsOpened += 1; },
    addNotice() {},
  };
  return {
    state,
    ...refs,
    reconcile: reconcileScript.runInNewContext(globals),
    sessionCommand: sessionCommandScript.runInNewContext(globals),
  };
}

for (const busyFlag of ["isStreaming", "isPromptRunning", "isCompacting"]) {
  test(`context usage advances while ${busyFlag} keeps the run busy`, async () => {
    const h = harness({ response: { running: true, state: { [busyFlag]: true, contextUsage: newUsage } } });
    await h.reconcile("session-a");
    assert.equal(h.state.contextUsage, newUsage);
    assert.equal(h.state.finished, 0);
  });
}

test("unknown post-compaction usage clears the old running percentage", async () => {
  const unknown = { tokens: null, contextWindow: 1_000_000, percent: null };
  const h = harness({ response: { running: true, state: { isStreaming: true, contextUsage: unknown } } });
  await h.reconcile("session-a");
  assert.equal(h.state.contextUsage, unknown);
});

test("a null usage value clears the ring and an omitted field preserves it", async () => {
  for (const [fields, expected] of [[{ contextUsage: null }, null], [{}, oldUsage]]) {
    const h = harness({ response: { running: true, state: { isStreaming: true, ...fields } } });
    await h.reconcile("session-a");
    assert.equal(h.state.contextUsage, expected);
  }
});

test("settled runs still refresh usage and finish the prompt", async () => {
  const h = harness({ response: { running: true, state: { isStreaming: false, contextUsage: newUsage } } });
  await h.reconcile("session-a");
  assert.equal(h.state.contextUsage, newUsage);
  assert.equal(h.state.finished, 1);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const change of ["session switch", "A-B-A session switch", "newer prompt"]) {
  test(`a late context-usage poll is ignored after ${change}`, async () => {
    const pending = deferred();
    const h = harness({ pending: pending.promise });
    const poll = h.reconcile("session-a");
    if (change === "session switch") h.sessionIdRef.current = "session-b";
    if (change === "A-B-A session switch") h.sessionGenerationRef.current += 2;
    if (change === "newer prompt") h.promptRunIdRef.current += 1;
    pending.resolve({ running: true, state: { isStreaming: true, contextUsage: newUsage } });
    await poll;
    assert.equal(h.state.contextUsage, oldUsage);
    assert.equal(h.state.finished, 0);
  });
}

test("/session refreshes the context usage consumed by the ring and stats panel", async () => {
  const stats = { contextUsage: newUsage };
  const h = harness({ stats });
  await h.sessionCommand("/session");
  assert.equal(h.state.stats, stats);
  assert.equal(h.state.contextUsage, newUsage);
  assert.equal(h.state.panelsOpened, 1);
});

test("/session respects null usage and preserves usage when the field is absent", async () => {
  for (const [stats, expected] of [[{ contextUsage: null }, null], [{}, oldUsage]]) {
    const h = harness({ stats });
    await h.sessionCommand("/session");
    assert.equal(h.state.contextUsage, expected);
  }
});

for (const change of ["session switch", "A-B-A session switch", "newer prompt"]) {
  test(`late /session stats are ignored after ${change}`, async () => {
    const pending = deferred();
    const h = harness({ pending: pending.promise });
    const command = h.sessionCommand("/session");
    if (change === "session switch") h.sessionIdRef.current = "session-b";
    if (change === "A-B-A session switch") h.sessionGenerationRef.current += 2;
    if (change === "newer prompt") h.promptRunIdRef.current += 1;
    pending.resolve({ contextUsage: newUsage });
    await command;
    assert.equal(h.state.contextUsage, oldUsage);
    assert.equal(h.state.stats, null);
    assert.equal(h.state.panelsOpened, 0);
  });
}
