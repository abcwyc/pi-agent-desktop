import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { makeDeps } from "./test-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { Scheduler, isRunRejectedError } = await jiti.import("./scheduler.ts");
const store = await jiti.import("./store.ts");
const { subscribeScheduledTaskEvents } = await jiti.import("./events.ts");

const ID = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const at = (iso) => new Date(iso);

function setup(t, { behavior, pid = 100, alive = () => true, now = "2026-10-07T09:00:30Z", cwd } = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-sched-"));
  const work = mkdtempSync(join(tmpdir(), "pi-web-sched-cwd-"));
  t.after(() => { rmSync(agentDir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });
  const clock = { now: at(now) };
  const deps = makeDeps({ behavior, clock: () => clock.now });
  const make = (overridePid = pid) => new Scheduler({ runnerDeps: deps, agentDir, pid: overridePid, isPidAlive: alive, now: () => clock.now });
  const scheduler = make();
  const addTask = (n, extra = {}) => store.mutateTasks((tasks) => {
    const task = {
      id: ID(n), name: `task ${n}`, prompt: "go", cwd: cwd ?? work,
      schedule: { kind: "cron", expr: "0 9 * * *", timezone: "UTC" },
      toolPreset: "read-only", maxDurationMin: 30, enabled: true,
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
      lastScheduledFor: "2026-10-06T09:00:00.000Z", consecutiveFailures: 0, ...extra,
    };
    return { tasks: [...tasks, task], result: task };
  }, agentDir);
  const settle = async () => {
    for (let i = 0; i < 200 && scheduler.activeRunCount() > 0; i += 1) await new Promise((r) => setImmediate(r));
  };
  return { agentDir, work, clock, deps, scheduler, make, addTask, settle };
}
const runsOf = (s, n = 1) => store.listRuns(ID(n), s.agentDir);
const taskOf = (s, n = 1) => store.getTask(ID(n), s.agentDir);

test("a task fires on time, once, and records the run against its session", async (t) => {
  const s = setup(t);
  s.addTask(1);
  await s.scheduler.tick();
  await s.settle();

  const [run] = runsOf(s);
  assert.equal(runsOf(s).length, 1);
  assert.equal(run.status, "succeeded");
  assert.equal(run.trigger, "schedule");
  assert.equal(run.scheduledFor, "2026-10-07T09:00:00.000Z");
  assert.equal(run.sessionId, "session-1");
  assert.equal(run.pid, 100);
  assert.equal(taskOf(s).lastScheduledFor, "2026-10-07T09:00:00.000Z");

  s.clock.now = at("2026-10-07T09:01:00Z");
  await s.scheduler.tick();
  await s.settle();
  assert.equal(runsOf(s).length, 1, "the same slot is not fired twice");
});

test("a task whose slot has not come yet does nothing, and neither does a paused or manual one", async (t) => {
  const s = setup(t, { now: "2026-10-07T08:59:00Z" });
  s.addTask(1);
  s.addTask(2, { enabled: false, now: undefined });
  s.addTask(3, { schedule: { kind: "manual" } });
  await s.scheduler.tick();
  assert.equal(s.deps.started.length, 0);

  s.clock.now = at("2026-10-07T09:00:30Z");
  await s.scheduler.tick();
  await s.settle();
  assert.deepEqual(s.deps.started.map((x) => x.cwd), [s.work], "only the enabled cron task ran");
});

test("a machine that slept through the slot gets one catch-up run", async (t) => {
  const s = setup(t, { now: "2026-10-07T14:00:00Z" });
  s.addTask(1, { lastScheduledFor: "2026-10-03T09:00:00.000Z" });
  await s.scheduler.tick();
  await s.settle();
  const [run] = runsOf(s);
  assert.equal(run.trigger, "catch-up");
  assert.equal(run.scheduledFor, "2026-10-07T09:00:00.000Z");
  assert.equal(run.skippedSlots, 3);
});

test("a slot too old to catch up is recorded as skipped and starts nothing", async (t) => {
  const s = setup(t, { now: "2026-10-20T12:00:00Z" });
  s.addTask(1, {
    schedule: { kind: "cron", expr: "0 9 1 * *", timezone: "UTC" },
    lastScheduledFor: "2026-09-01T09:00:00.000Z",
  });
  await s.scheduler.tick();
  const [run] = runsOf(s);
  assert.equal(run.status, "skipped");
  assert.equal(run.skipReason, "app-asleep");
  assert.equal(s.deps.started.length, 0);
  assert.equal(taskOf(s).lastScheduledFor, "2026-10-01T09:00:00.000Z");
});

test("a one-time task runs once and switches itself off", async (t) => {
  const s = setup(t);
  s.addTask(1, { schedule: { kind: "once", at: "2026-10-07T09:00:00.000Z" }, lastScheduledFor: "2026-10-07T08:00:00.000Z" });
  await s.scheduler.tick();
  await s.settle();
  assert.equal(runsOf(s)[0].status, "succeeded");
  assert.equal(taskOf(s).enabled, false);
  await s.scheduler.tick();
  assert.equal(runsOf(s).length, 1);
});

test("a slot that arrives while the task is still running is skipped as an overlap", async (t) => {
  const s = setup(t, { alive: (pid) => pid === 555 });
  s.addTask(1);
  // Another live process (pid 555) is mid-run on this task.
  store.appendRun({ runId: "other", taskId: ID(1), trigger: "manual", status: "running", startedAt: "2026-10-07T08:55:00.000Z", pid: 555 }, s.agentDir);
  await s.scheduler.tick();
  const skipped = runsOf(s).find((r) => r.status === "skipped");
  assert.equal(skipped.skipReason, "overlap");
  assert.equal(s.deps.started.length, 0);
  assert.equal(taskOf(s).lastScheduledFor, "2026-10-07T09:00:00.000Z");
});

test("at most two scheduled runs start at once; the rest wait for a free slot", async (t) => {
  const s = setup(t, { behavior: () => "hold" });
  s.addTask(1); s.addTask(2); s.addTask(3);
  await s.scheduler.tick();
  assert.equal(s.deps.started.length, 2);
  assert.equal(taskOf(s, 3).lastScheduledFor, "2026-10-06T09:00:00.000Z", "the waiting task's slot is not claimed");

  for (const { session } of s.deps.started) session.finish("ok");
  await s.settle();
  await s.scheduler.tick();
  await s.settle();
  assert.equal(s.deps.started.length, 3);
  assert.equal(runsOf(s, 3)[0].trigger, "schedule");
  // The third session also holds; end it so its time-limit timer does not outlive the test.
  s.deps.started[2].session.finish("ok");
  await s.settle();
});

test("only the lease holder fires tasks, and another process takes over after it stops", async (t) => {
  const s = setup(t);
  s.addTask(1);
  const other = s.make(200);
  await s.scheduler.tick();
  assert.equal(s.scheduler.isOwner(), true);
  await other.tick();
  assert.equal(other.isOwner(), false);
  await s.settle();
  assert.equal(s.deps.started.length, 1);

  // A second task becomes due; the non-owner still does not fire it.
  s.addTask(2);
  await other.tick();
  assert.equal(s.deps.started.length, 1);

  await s.scheduler.stop();
  await other.tick();
  await s.settle();
  assert.equal(other.isOwner(), true);
  assert.equal(s.deps.started.length, 2);
});

test("two owners racing for one slot cannot both claim it", async (t) => {
  const s = setup(t);
  s.addTask(1);
  const rival = s.make(200);
  // Both believe they own the lease and decide on the same stored state.
  rival.owner = true;
  s.scheduler.owner = true;
  const task = taskOf(s);
  const since = new Date(task.lastScheduledFor);
  const slot = at("2026-10-07T09:00:00Z");
  const first = s.scheduler.claimSlot(task, since, slot);
  const second = rival.claimSlot(task, since, slot);
  assert.ok(first);
  assert.equal(second, undefined);
});

test("the fifth failure in a row pauses the task, a success resets the count", async (t) => {
  const s = setup(t, { behavior: () => "startFails" });
  s.addTask(1, { consecutiveFailures: 4 });
  await s.scheduler.tick();
  await s.settle();
  const paused = taskOf(s);
  assert.equal(paused.enabled, false);
  assert.equal(paused.consecutiveFailures, 5);
  assert.match(paused.autoPausedReason, /Paused after 5 failed runs/);

  const ok = setup(t);
  ok.addTask(1, { consecutiveFailures: 3 });
  await ok.scheduler.tick();
  await ok.settle();
  assert.equal(taskOf(ok).consecutiveFailures, 0);
  assert.equal(taskOf(ok).enabled, true);
});

test("a folder that has disappeared fails the run without starting a session", async (t) => {
  const s = setup(t, { cwd: "/definitely/not/here" });
  s.addTask(1);
  await s.scheduler.tick();
  await s.settle();
  const [run] = runsOf(s);
  assert.equal(run.status, "failed");
  assert.match(run.error, /Directory does not exist/);
  assert.equal(s.deps.started.length, 0);
  assert.equal(taskOf(s).consecutiveFailures, 1);
});

test("runs left 'running' by a dead process are closed when this process takes over", async (t) => {
  const s = setup(t, { alive: (pid) => pid !== 555 });
  s.addTask(1, { schedule: { kind: "manual" } });
  store.appendRun({ runId: "ghost", taskId: ID(1), trigger: "schedule", status: "running", startedAt: "2026-10-07T08:00:00.000Z", pid: 555 }, s.agentDir);
  await s.scheduler.tick();
  const [ghost] = runsOf(s);
  assert.equal(ghost.status, "aborted");
  assert.match(ghost.error, /Interrupted/);
  assert.ok(ghost.endedAt);
});

test("runNow starts a run, reports its session, and refuses a second while it runs", async (t) => {
  const s = setup(t, { behavior: () => "hold" });
  s.addTask(1, { schedule: { kind: "manual" } });
  const { run, done } = await s.scheduler.runNow(ID(1));
  assert.equal(run.trigger, "manual");
  assert.equal(run.sessionId, "session-1");
  await assert.rejects(() => s.scheduler.runNow(ID(1)), (error) => isRunRejectedError(error) && error.code === "already_running");
  s.deps.started[0].session.finish("ok");
  const finished = await done;
  assert.equal(finished.status, "succeeded");
  assert.ok(finished.endedAt);
  await assert.rejects(() => s.scheduler.runNow(ID(2)), (error) => isRunRejectedError(error) && error.code === "not_found");
});

test("a manual run fails fast, with a record, when the session cannot start", async (t) => {
  const s = setup(t, { behavior: () => "startFails" });
  s.addTask(1, { schedule: { kind: "manual" } });
  const { run } = await s.scheduler.runNow(ID(1));
  assert.equal(run.status, "failed");
  assert.equal(run.error, "could not start");
});

test("events describe a run from start to finish", async (t) => {
  const s = setup(t);
  s.addTask(1);
  const seen = [];
  const unsubscribe = subscribeScheduledTaskEvents((event) => seen.push(event));
  t.after(unsubscribe);
  await s.scheduler.tick();
  await s.settle();
  const types = seen.map((event) => event.type);
  assert.ok(types.indexOf("run_started") < types.indexOf("run_finished"));
  assert.ok(types.includes("scheduler_owner"));
  assert.ok(types.includes("task_changed"));

  const started = seen.find((event) => event.type === "run_started");
  const done = seen.find((event) => event.type === "run_finished");
  assert.equal(started.taskName, "task 1");
  assert.equal(done.taskName, "task 1");
  assert.equal(done.trigger, "schedule");
  assert.equal(done.status, "succeeded");
  assert.equal(done.autoPaused, undefined);
});

test("the run that pauses a task says so in its event, and the user's own Stop is recognisable", async (t) => {
  const failing = setup(t, { behavior: () => "startFails" });
  failing.addTask(1, { consecutiveFailures: 4 });
  const seen = [];
  const unsubscribe = subscribeScheduledTaskEvents((event) => seen.push(event));
  t.after(unsubscribe);
  await failing.scheduler.tick();
  await failing.settle();
  const done = seen.find((event) => event.type === "run_finished");
  assert.equal(done.status, "failed");
  assert.equal(done.autoPaused, true);

  const stopped = setup(t, { behavior: () => "userAborted" });
  stopped.addTask(1);
  const seenStop = [];
  const off = subscribeScheduledTaskEvents((event) => seenStop.push(event));
  t.after(off);
  await stopped.scheduler.tick();
  await stopped.settle();
  const end = seenStop.find((event) => event.type === "run_finished");
  assert.equal(end.status, "aborted");
  assert.equal(end.error, "Stopped by the user");
});

test("a damaged tasks file is reported by the tick, not turned into data loss", async (t) => {
  const s = setup(t);
  mkdirSync(s.agentDir, { recursive: true });
  writeFileSync(store.scheduledTasksFile(s.agentDir), "{ broken");
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  await s.scheduler.tick();
  assert.equal(s.deps.started.length, 0);
});
