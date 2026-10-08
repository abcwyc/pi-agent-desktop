import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { describeRunNotification, shortError } = await createJiti(import.meta.url).import("./notification-text.ts");

const t = (key) => key;
const finished = (extra) => ({ type: "run_finished", taskId: "t", taskName: "Morning review", runId: "r1", sessionId: "s1", trigger: "schedule", status: "succeeded", ...extra });

test("a successful run names the task and plays the sound", () => {
  assert.deepEqual(describeRunNotification(finished({}), t), {
    title: "scheduled.notify.succeeded", body: "Morning review", tag: "pi-scheduled:r1:end", sessionId: "s1", sound: true,
  });
});

test("a failed run carries the first line of the error and stays quiet", () => {
  const n = describeRunNotification(finished({ status: "failed", error: "500: upstream exploded\nstack line 2" }), t);
  assert.equal(n.title, "scheduled.notify.failed");
  assert.equal(n.body, "Morning review — 500: upstream exploded");
  assert.equal(n.sound, false);
});

test("a run that paused its task says so", () => {
  const n = describeRunNotification(finished({ status: "failed", error: "boom", autoPaused: true }), t);
  assert.match(n.body, /scheduled\.notify\.pausedNote$/);
});

test("a run that hit its time limit is reported as stopped", () => {
  const n = describeRunNotification(finished({
    status: "aborted",
    error: "Stopped after reaching the 30 minute limit",
    errorCode: "time-limit",
    errorParams: { minutes: 30 },
  }), (key, params) => (params ? `${key}${JSON.stringify(params)}` : key));
  assert.equal(n.title, "scheduled.notify.stopped");
  assert.equal(n.body, 'Morning review — scheduled.runError.timeLimit{"minutes":30}', "an error with a code is localised, not shown in English");
});

test("a run the user stopped by hand is not worth a notification", () => {
  assert.equal(describeRunNotification(finished({ status: "aborted", error: "Stopped by the user", errorCode: "stopped" }), t), null);
});

test("only a catch-up start is announced; ordinary starts and other events are not", () => {
  const started = (trigger) => ({ type: "run_started", taskId: "t", taskName: "Morning review", runId: "r1", sessionId: "s1", trigger });
  assert.equal(describeRunNotification(started("schedule"), t), null);
  assert.equal(describeRunNotification(started("manual"), t), null);
  const catchUp = describeRunNotification(started("catch-up"), t);
  assert.equal(catchUp.title, "scheduled.notify.catchUp");
  assert.equal(catchUp.sound, false);
  assert.equal(catchUp.tag, "pi-scheduled:r1:start");
  assert.equal(describeRunNotification({ type: "task_changed", taskId: "t" }, t), null);
  assert.equal(describeRunNotification({ type: "run_skipped", taskId: "t", runId: "r", skipReason: "overlap" }, t), null);
  assert.equal(describeRunNotification({ type: "scheduler_owner", owner: true }, t), null);
  assert.deepEqual(
    describeRunNotification({ type: "run_attention", taskId: "t", taskName: "Morning review", runId: "r1", sessionId: "s1" }, t),
    { title: "scheduled.notify.attention", body: "Morning review", tag: "pi-scheduled:r1:attention", sessionId: "s1", sound: false },
  );
});

test("a long error is cut, and a run without a session still notifies", () => {
  assert.equal(shortError("x".repeat(300)).length, 140);
  assert.ok(shortError("x".repeat(300)).endsWith("…"));
  assert.equal(shortError(undefined), "");
  assert.equal(shortError("\n\n  real line\nother"), "real line");
  const n = describeRunNotification(finished({ sessionId: undefined, status: "failed", error: "no session" }), t);
  assert.equal("sessionId" in n, false);
});
