import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { makeDeps } from "./test-helpers.mjs";

const runner = await createJiti(import.meta.url).import("./runner.ts");

const task = (extra = {}) => ({
  id: "00000000-0000-4000-8000-000000000001", name: "Daily review", prompt: "Review the commits", cwd: "/work",
  schedule: { kind: "manual" }, toolPreset: "read-only", maxDurationMin: 30, enabled: true,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", consecutiveFailures: 0, ...extra,
});
const info = { runId: "run-1", trigger: "schedule", scheduledFor: "2026-10-07T09:00:00.000Z" };

test("a finished run succeeds, is tagged and named, and sends the prompt", async () => {
  const deps = makeDeps({ clock: () => new Date(2026, 9, 7, 9, 5) });
  const order = [];
  const outcome = await runner.executeRun(task(), info, deps, () => order.push("ready"));
  const { session, sessionId } = deps.started[0];

  assert.deepEqual(outcome, { status: "succeeded", sessionId, countsAsFailure: false });
  assert.deepEqual(session.entries, [{
    customType: runner.SCHEDULED_RUN_ENTRY_TYPE,
    data: { version: 1, taskId: task().id, runId: "run-1", taskName: "Daily review", trigger: "schedule", scheduledFor: info.scheduledFor },
  }]);
  assert.deepEqual(session.sent.map((c) => c.type), ["set_session_name", "prompt"]);
  assert.equal(session.sent[0].name, "Daily review · 10-07 09:05");
  assert.equal(session.sent[1].message, "Review the commits");
  assert.deepEqual(order, ["ready"]);
});

test("the tool preset reaches the session as an explicit tool list", async () => {
  for (const [preset, tools] of [
    ["read-only", ["read", "grep", "find", "ls"]],
    ["none", []],
    ["default", ["read", "bash", "edit", "write"]],
  ]) {
    const deps = makeDeps();
    await runner.executeRun(task({ toolPreset: preset }), info, deps);
    assert.deepEqual(deps.started[0].options.toolNames, tools, preset);
  }
});

test("model, thinking level and cwd are passed through, with model fallback allowed", async () => {
  const deps = makeDeps();
  await runner.executeRun(task({ model: { provider: "p", modelId: "m" }, thinkingLevel: "high" }), info, deps);
  const [{ cwd, options }] = deps.started;
  assert.equal(cwd, "/work");
  assert.deepEqual(options.initialModel, { provider: "p", modelId: "m" });
  assert.equal(options.thinkingLevel, "high");
  assert.equal(options.allowInitialModelFallback, true);
});

test("a model error in the last reply fails the run", async () => {
  const outcome = await runner.executeRun(task(), info, makeDeps({ behavior: () => "error" }));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "boom");
  assert.equal(outcome.countsAsFailure, true);
});

test("a prompt error fails the run", async () => {
  const outcome = await runner.executeRun(task(), info, makeDeps({ behavior: () => "promptError" }));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "preflight exploded");
});

test("stopping the session by hand is aborted and does not count against the task", async () => {
  const outcome = await runner.executeRun(task(), info, makeDeps({ behavior: () => "userAborted" }));
  assert.equal(outcome.status, "aborted");
  assert.equal(outcome.countsAsFailure, false);
});

test("a run that exceeds its time limit is aborted and counted as a failure", async () => {
  const deps = makeDeps({ behavior: () => "hang", extra: { durationMs: 20, abortGraceMs: 200 } });
  const outcome = await runner.executeRun(task({ maxDurationMin: 1 }), info, deps);
  assert.equal(outcome.status, "aborted");
  assert.equal(outcome.countsAsFailure, true);
  assert.match(outcome.error, /1 minute limit/);
  assert.ok(deps.started[0].session.sent.some((c) => c.type === "abort"));
});

test("a session that ignores the abort is given up on after the grace period", async () => {
  const deps = makeDeps({ behavior: () => "hold", extra: { durationMs: 10, abortGraceMs: 30 } });
  const outcome = await runner.executeRun(task(), info, deps);
  assert.equal(outcome.status, "aborted");
  assert.ok(deps.started[0].session.sent.some((c) => c.type === "abort"));
});

test("a rejected prompt and a session that cannot start both fail the run", async () => {
  const rejected = await runner.executeRun(task(), info, makeDeps({ behavior: () => "rejectSend" }));
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.error, "prompt rejected");
  assert.ok(rejected.sessionId, "the session exists even though the prompt was rejected");

  const failed = await runner.executeRun(task(), info, makeDeps({ behavior: () => "startFails" }));
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "could not start");
  assert.equal(failed.sessionId, undefined);
});

test("a dialog that blocks the run is reported once, and the run keeps waiting for an answer", async () => {
  const deps = makeDeps({ behavior: () => "hold", extra: { durationMs: 200, abortGraceMs: 20 } });
  let asked = 0;
  const pending = runner.executeRun(task(), info, deps, undefined, () => { asked += 1; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const { session } = deps.started[0];

  session.emit({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Run rm?", message: "sure?" });
  session.emit({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Run rm?", message: "sure?" });
  session.emit({ type: "extension_ui_request", id: "n1", method: "notify", message: "just so you know" });
  session.emit({ type: "extension_ui_request", id: "d2", method: "input", title: "Name?" });
  assert.equal(asked, 2, "each blocking request once; a plain notice and a repeat are not asked for again");

  session.finish("ok");
  assert.equal((await pending).status, "succeeded");
});
