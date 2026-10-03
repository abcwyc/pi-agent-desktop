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

function findHandler(node, name) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
    return node.initializer.arguments[0];
  }
  return ts.forEachChild(node, (child) => findHandler(child, name));
}

function compileHandler(name) {
  const handler = findHandler(source, name);
  assert.ok(handler, `handler ${name} not found`);
  return new Script(ts.transpileModule(handler.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
}

const handleAgentEvent = compileHandler("handleAgentEvent");
const reportCompactFailure = compileHandler("reportCompactFailure");

function findFunction(node, name) {
  if (ts.isFunctionDeclaration(node) && node.name?.getText(source) === name) return node;
  return ts.forEachChild(node, (child) => findFunction(child, name));
}
const compactNoopMessage = new Script(`(${ts.transpileModule(
  findFunction(source, "compactNoopMessage").getText(source).replace(/^export /, ""),
  { compilerOptions: { target: ts.ScriptTarget.ES2020 } },
).outputText})`).runInNewContext({});

/** Drive handleAgentEvent with recorded state setters. */
function harness() {
  const state = {
    pendingBash: { command: "npm test", excludeFromContext: false, output: "" },
    summarizationRetry: null,
    isCompacting: false,
    compactError: null,
    compactNotice: null,
    compactResult: null,
    liveThinkingLevel: null,
    loadedSessions: [],
  };
  const bashRunningRef = { current: true };
  const agentRunningRef = { current: false };
  let compactFailure;
  const handler = handleAgentEvent.runInNewContext({
    dispatch() {},
    cancelEventStreamGrace() {},
    sdkAgentActiveRef: { current: false },
    bashRunningRef,
    agentRunningRef,
    sessionIdRef: { current: "s1" },
    externalAppendRefreshAtRef: { current: 0 },
    setAgentRunning() {}, setAgentPhase() {}, setRetryInfo() {},
    setIsCompacting(v) { state.isCompacting = v; },
    setCompactError(v) { state.compactError = v; },
    setCompactNotice(v) { state.compactNotice = v; },
    setCompactResult(v) { state.compactResult = v; },
    get reportCompactFailure() { return compactFailure; },
    setQueuedMessages() {},
    setExtensionDialog() {},
    setActiveToolResults() {},
    setLiveModel() {},
    setLiveThinkingLevel(v) { state.liveThinkingLevel = v; },
    setSummarizationRetry(v) { state.summarizationRetry = v; },
    setPendingBash(updater) { state.pendingBash = updater(state.pendingBash); },
    setContextUsage() {}, setSystemPrompt() {}, setExtensionStatuses() {}, setExtensionWidgets() {},
    scrollToBottom() {},
    notifyPromptStage() {},
    settleUiStage() {},
    scheduleEventStreamClose() {},
    syncLiveModel() {},
    onAgentEnd() {},
    addNotice() {},
    loadSession(sid) { state.loadedSessions.push(sid); },
    handleExtensionUiRequest() {},
    normalizeQueuedMessages: (v) => v,
    readCompactResult: (result, reason) => ({ reason, result }),
    asConcreteThinkingLevel: (v) => v,
    PENDING_BASH_OUTPUT_CAP: 100,
    Date,
    console,
    window: undefined, document: undefined,
  });
  compactFailure = reportCompactFailure.runInNewContext({
    compactNoopMessage,
    setCompactError(v) { state.compactError = v; },
    setCompactNotice(v) { state.compactNotice = v; },
    setCompactResult(v) { state.compactResult = v; },
  });
  return { handler, state, bashRunningRef, agentRunningRef };
}

test("bash_execution_update accumulates live output into the pending bash bubble", () => {
  const { handler, state } = harness();
  handler({ type: "bash_execution_update", delta: "ok 1\n" });
  handler({ type: "bash_execution_update", delta: "ok 2\n" });
  assert.equal(state.pendingBash.output, "ok 1\nok 2\n");

  // Tail-capped so a chatty command cannot grow state unbounded (cap=100 here).
  handler({ type: "bash_execution_update", delta: "x".repeat(150) });
  assert.ok(state.pendingBash.output.length <= 100);
  assert.ok(state.pendingBash.output.endsWith("x".repeat(100)));

  // Ignored when no bash command is pending.
  state.pendingBash = null;
  handler({ type: "bash_execution_update", delta: "ignored" });
  assert.equal(state.pendingBash, null);
});

test("summarization_retry events surface the retry counter and clear on finish", () => {
  const { handler, state } = harness();
  handler({ type: "summarization_retry_scheduled", attempt: 2, maxAttempts: 5, delayMs: 1000, errorMessage: "boom" });
  assert.equal(state.summarizationRetry.attempt, 2);
  assert.equal(state.summarizationRetry.maxAttempts, 5);
  handler({ type: "summarization_retry_attempt_start", source: "compaction", reason: "threshold" });
  assert.equal(state.summarizationRetry.attempt, 2);
  handler({ type: "summarization_retry_finished" });
  assert.equal(state.summarizationRetry, null);
});

test("compaction_end with willRetry keeps the retry counter for the countdown", () => {
  const { handler, state } = harness();
  handler({ type: "compaction_start", reason: "threshold" });
  assert.equal(state.isCompacting, true);
  handler({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: "e" });
  handler({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: true, errorMessage: "e" });
  assert.equal(state.isCompacting, false);
  assert.equal(state.summarizationRetry.attempt, 1);
  assert.equal(state.summarizationRetry.maxAttempts, 3);

  handler({ type: "compaction_end", reason: "manual", result: {}, aborted: false, willRetry: false });
  assert.equal(state.summarizationRetry, null);
});

test("a compact with nothing to fold is a notice, not an error", () => {
  const { handler, state } = harness();
  handler({ type: "compaction_start", reason: "manual" });
  handler({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false, errorMessage: "Compaction failed: Nothing to compact (session too small)" });
  assert.equal(state.compactNotice, "Nothing to compact (session too small)");
  assert.equal(state.compactError, null);

  handler({ type: "compaction_start", reason: "manual" });
  assert.equal(state.compactNotice, null);
  handler({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false, errorMessage: "Already compacted" });
  assert.equal(state.compactNotice, "Already compacted");

  handler({ type: "compaction_start", reason: "manual" });
  handler({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false, errorMessage: "Compaction failed: 401 Unauthorized" });
  assert.equal(state.compactError, "Compaction failed: 401 Unauthorized");
  assert.equal(state.compactNotice, null);
});

test("thinking_level_changed updates the live level immediately", () => {
  const { handler, state } = harness();
  handler({ type: "thinking_level_changed", level: "high" });
  assert.equal(state.liveThinkingLevel, "high");
});

test("entry_appended refreshes the transcript only when idle and throttled", () => {
  const { handler, state, agentRunningRef, bashRunningRef } = harness();
  bashRunningRef.current = false;
  agentRunningRef.current = true;
  handler({ type: "entry_appended", entry: {} });
  assert.equal(state.loadedSessions.length, 0);

  agentRunningRef.current = false;
  handler({ type: "entry_appended", entry: {} });
  assert.equal(state.loadedSessions.length, 1);
  assert.equal(state.loadedSessions[0], "s1");

  // Second append within the throttle window is dropped.
  handler({ type: "entry_appended", entry: {} });
  assert.equal(state.loadedSessions.length, 1);
});

test("legacy auto_compaction_* events are no longer handled", () => {
  const src = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /case "auto_compaction_start"/);
  assert.doesNotMatch(src, /case "auto_compaction_end"/);
});
