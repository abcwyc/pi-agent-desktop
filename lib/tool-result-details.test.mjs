import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  projectToolResultDetails,
  slimToolExecutionResult,
  slimToolResultMessage,
} = await jiti.import("./tool-result-details.ts");
const { toClientAgentEvent } = await jiti.import("./agent-event-wire.ts");
const {
  buildSessionContext,
  invalidateSessionManagerCache,
  openSessionManager,
} = await jiti.import("./session-reader.ts");

const HUGE_OUTLINE = { root: { children: [{ text: "x".repeat(10_000) }] } };

test("details the UI never reads are dropped", () => {
  assert.equal(projectToolResultDetails({ outline: HUGE_OUTLINE, url: "https://x" }), undefined);
});

test("rendered fields survive and unchanged details keep their identity", () => {
  const editDetails = { diff: "@@ -1 +1 @@", firstChangedLine: 3 };
  assert.deepEqual(projectToolResultDetails(editDetails), { diff: "@@ -1 +1 @@" });

  const patchDetails = { preview: [{ path: "a" }], result: { appliedFiles: ["a"] } };
  assert.equal(projectToolResultDetails(patchDetails), patchDetails);

  const subagent = { kind: "pi-web-subagent", sessionId: "s", transcript: HUGE_OUTLINE };
  assert.equal(projectToolResultDetails(subagent), subagent);
});

test("messages without droppable details are returned as-is", () => {
  const user = { role: "user", content: "hi" };
  assert.equal(slimToolResultMessage(user), user);
  const plain = { role: "toolResult", toolCallId: "t", content: [], details: { diff: "d" } };
  assert.equal(slimToolResultMessage(plain), plain);

  const bloated = { role: "toolResult", toolCallId: "t", content: [], details: { outline: HUGE_OUTLINE } };
  const slim = slimToolResultMessage(bloated);
  assert.equal("details" in slim, false);
  assert.ok(bloated.details, "the input message is not mutated");

  assert.deepEqual(slimToolExecutionResult({ content: [], details: { outline: 1 } }), { content: [] });
});

test("SSE frames carry projected tool-result details", () => {
  const message = { role: "toolResult", toolCallId: "t", toolName: "evaluate_browser", content: [], details: { outline: HUGE_OUTLINE } };
  assert.equal("details" in toClientAgentEvent({ type: "message_end", message }).message, false);
  // Since the upstream SSE slimming, a tool_execution_end carries no result at
  // all: only ids and isError reach the browser; the toolResult message that
  // follows carries the (projected) details.
  const endEvent = toClientAgentEvent({ type: "tool_execution_end", toolCallId: "t", toolName: "x", result: { content: [], details: { outline: 1 } } });
  assert.equal("result" in endEvent, false);
  assert.equal("details" in toClientAgentEvent({ type: "tool_execution_update", toolCallId: "t", toolName: "x", partialResult: { content: [], details: { outline: 1 } } }).partialResult, false);
});

test("session context and the SessionManager cache drop extension payloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-details-"));
  try {
    const file = join(dir, "s.jsonl");
    const ts = "2026-09-26T00:00:00.000Z";
    const lines = [
      { type: "session", version: 3, id: "01a0d979-380b-7791-85c9-4886bfa8b3c9", timestamp: ts, cwd: dir },
      { type: "message", id: "u1", parentId: null, timestamp: ts, message: { role: "user", content: "go", timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "evaluate_browser", arguments: {} }], timestamp: 2 } },
      { type: "message", id: "r1", parentId: "a1", timestamp: ts, message: { role: "toolResult", toolCallId: "t1", toolName: "evaluate_browser", content: [{ type: "text", text: "ok" }], details: { outline: HUGE_OUTLINE }, isError: false, timestamp: 3 } },
      { type: "message", id: "r2", parentId: "r1", timestamp: ts, message: { role: "toolResult", toolCallId: "t2", toolName: "edit", content: [{ type: "text", text: "ok" }], details: { diff: "@@", firstChangedLine: 1 }, isError: false, timestamp: 4 } },
    ];
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

    invalidateSessionManagerCache(file);
    const sm = openSessionManager(file);
    const context = buildSessionContext(sm.getEntries(), sm.getLeafId(), {});
    const results = context.messages.filter((m) => m.role === "toolResult");
    assert.equal("details" in results[0], false);
    assert.deepEqual(results[1].details, { diff: "@@" });

    const cachedResult = sm.getEntries().find((entry) => entry.id === "r1").message;
    assert.equal("details" in cachedResult, false, "the cached read-only view is slimmed");
    assert.equal(openSessionManager(file), sm, "repeat opens hit the cache");
  } finally {
    invalidateSessionManagerCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
