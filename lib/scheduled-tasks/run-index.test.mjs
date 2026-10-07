import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const index = await jiti.import("./run-index.ts");
const store = await jiti.import("./store.ts");
const { emitScheduledTaskEvent } = await jiti.import("./events.ts");

const ID = (n) => `00000000-0000-4000-8000-00000000000${n}`;

function agentDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-run-index-"));
  t.after(() => { index.invalidateScheduledRunIndex(); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const run = (n, taskId, sessionId) => ({ runId: `run-${n}`, taskId, trigger: "manual", status: "succeeded", ...(sessionId ? { sessionId } : {}) });

test("sessions are mapped to the task and run that produced them", (t) => {
  const dir = agentDir(t);
  store.appendRun(run(1, ID(1), "s1"), dir);
  store.appendRun(run(2, ID(2), "s2"), dir);
  store.appendRun(run(3, ID(2)), dir); // a run that never got a session
  const map = index.getScheduledSessionRuns({ agentDir: dir, now: 1 });
  assert.deepEqual([...map.entries()].sort(), [
    ["s1", { taskId: ID(1), runId: "run-1" }],
    ["s2", { taskId: ID(2), runId: "run-2" }],
  ]);
});

test("the index is reused until it ages out or an event invalidates it", (t) => {
  const dir = agentDir(t);
  store.appendRun(run(1, ID(1), "s1"), dir);
  const first = index.getScheduledSessionRuns({ agentDir: dir, now: 1000 });
  store.appendRun(run(2, ID(1), "s2"), dir);

  assert.equal(index.getScheduledSessionRuns({ agentDir: dir, now: 2000 }), first, "within the age limit it is the same map");
  assert.equal(first.has("s2"), false);

  emitScheduledTaskEvent({ type: "run_finished", taskId: ID(1), runId: "run-2", status: "succeeded" });
  assert.equal(index.getScheduledSessionRuns({ agentDir: dir, now: 2001 }).has("s2"), true, "an event forces a rebuild");

  store.appendRun(run(3, ID(1), "s3"), dir);
  assert.equal(index.getScheduledSessionRuns({ agentDir: dir, now: 2002 }).has("s3"), false);
  assert.equal(index.getScheduledSessionRuns({ agentDir: dir, now: 2001 + 5001 }).has("s3"), true, "it ages out");
});

test("attachScheduledRelations tags only the sessions a run produced and leaves the rest alone", () => {
  const sessions = [
    { id: "s1", name: "a", relation: undefined },
    { id: "plain", name: "b", relation: { kind: "fork" } },
  ];
  const runs = new Map([["s1", { taskId: ID(1), runId: "run-1" }]]);
  const out = index.attachScheduledRelations(sessions, runs);
  assert.deepEqual(out[0].relation, { kind: "scheduled", taskId: ID(1), runId: "run-1" });
  assert.equal(out[1], sessions[1], "untouched sessions are the same object");
  assert.equal(sessions[0].relation, undefined, "the input is not mutated");
  assert.equal(index.attachScheduledRelations(sessions, new Map()), sessions, "no runs means no copy");
});
