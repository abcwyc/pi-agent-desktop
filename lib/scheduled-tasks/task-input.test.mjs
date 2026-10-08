import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { buildTask, applyTaskPatch } = await createJiti(import.meta.url).import("./task-input.ts");

const now = new Date("2026-10-07T10:00:00Z");
const ctx = { now, otherNames: [] };

function dir(t) {
  const path = mkdtempSync(join(tmpdir(), "pi-web-sched-input-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const base = (cwd, extra = {}) => ({
  name: "Daily review", prompt: "Review today's commits", cwd,
  schedule: { kind: "cron", expr: "0 9 * * *", timezone: "UTC" }, ...extra,
});

test("a new task defaults to the read-only preset and starts its catch-up window now", (t) => {
  const task = buildTask(base(dir(t)), ctx);
  assert.equal(task.toolPreset, "read-only");
  assert.equal(task.enabled, true);
  assert.equal(task.maxDurationMin, 30);
  assert.equal(task.lastScheduledFor, now.toISOString());
  assert.match(task.id, /^[0-9a-f-]{36}$/);
});

test("presets that can write need acknowledgeUnattendedWrites", (t) => {
  const cwd = dir(t);
  assert.throws(() => buildTask(base(cwd, { toolPreset: "full" }), ctx), /acknowledgeUnattendedWrites/);
  assert.throws(() => buildTask(base(cwd, { toolPreset: "default", acknowledgeUnattendedWrites: "yes" }), ctx), /acknowledgeUnattendedWrites/);
  assert.equal(buildTask(base(cwd, { toolPreset: "full", acknowledgeUnattendedWrites: true }), ctx).toolPreset, "full");
  assert.equal(buildTask(base(cwd, { toolPreset: "none" }), ctx).toolPreset, "none");
});

test("validation rejects bad fields", (t) => {
  const cwd = dir(t);
  assert.throws(() => buildTask(base(cwd, { name: "  " }), ctx), /name is required/);
  assert.throws(() => buildTask(base(cwd, { prompt: "" }), ctx), /prompt is required/);
  assert.throws(() => buildTask(base("relative/path"), ctx), /absolute path/);
  assert.throws(() => buildTask(base(join(cwd, "missing")), ctx), /does not exist/);
  assert.throws(() => buildTask(base(cwd, { toolPreset: "everything" }), ctx), /toolPreset must be one of/);
  assert.throws(() => buildTask(base(cwd, { thinkingLevel: "extreme" }), ctx), /thinkingLevel/);
  assert.throws(() => buildTask(base(cwd, { maxDurationMin: 0 }), ctx), /maxDurationMin/);
  assert.throws(() => buildTask(base(cwd, { model: { provider: "x" } }), ctx), /model must be/);
  assert.throws(() => buildTask(base(cwd, { schedule: { kind: "cron", expr: "* * * * *" } }), ctx), /at least 5 minutes/);
  assert.throws(() => buildTask(base(cwd, { schedule: { kind: "once", at: "2026-10-07T09:00:00Z" } }), ctx), /in the future/);
  assert.throws(() => buildTask(base(cwd, { schedule: { kind: "weekly" } }), ctx), /schedule.kind/);
  assert.throws(() => buildTask("nope", ctx), /body must be an object/);
});

test("names are unique ignoring case", (t) => {
  assert.throws(
    () => buildTask(base(dir(t), { name: "DAILY REVIEW" }), { now, otherNames: ["Daily review"] }),
    /already exists/,
  );
});

test("a cron expression is normalised and the timezone defaults to the system one", (t) => {
  const task = buildTask(base(dir(t), { schedule: { kind: "cron", expr: "  0   9 * *  *  " } }), ctx);
  assert.equal(task.schedule.expr, "0 9 * * *");
  assert.equal(typeof task.schedule.timezone, "string");
});

test("patching changes only the given fields and keeps the rest", (t) => {
  const task = buildTask(base(dir(t)), ctx);
  const later = new Date("2026-10-08T10:00:00Z");
  const next = applyTaskPatch(task, { prompt: "New prompt" }, { now: later, otherNames: [] });
  assert.equal(next.prompt, "New prompt");
  assert.equal(next.name, task.name);
  assert.equal(next.updatedAt, later.toISOString());
  assert.equal(next.lastScheduledFor, task.lastScheduledFor);
});

test("changing the schedule restarts the catch-up window", (t) => {
  const task = buildTask(base(dir(t)), ctx);
  const later = new Date("2026-10-08T10:00:00Z");
  const next = applyTaskPatch(task, { schedule: { kind: "cron", expr: "0 18 * * *", timezone: "UTC" } }, { now: later, otherNames: [] });
  assert.equal(next.lastScheduledFor, later.toISOString());
});

test("resuming a paused task restarts its window and clears the auto-pause", (t) => {
  const task = { ...buildTask(base(dir(t)), ctx), enabled: false, consecutiveFailures: 5, autoPausedReason: "Paused after 5" };
  const later = new Date("2026-10-08T10:00:00Z");
  const next = applyTaskPatch(task, { enabled: true }, { now: later, otherNames: [] });
  assert.equal(next.enabled, true);
  assert.equal(next.consecutiveFailures, 0);
  assert.equal(next.autoPausedReason, undefined);
  assert.equal(next.lastScheduledFor, later.toISOString());
  // Pausing again does not touch the window.
  const paused = applyTaskPatch(next, { enabled: false }, { now: later, otherNames: [] });
  assert.equal(paused.lastScheduledFor, later.toISOString());
});

test("giving a finished one-time task a new schedule switches it back on", (t) => {
  const task = { ...buildTask(base(dir(t), { schedule: { kind: "once", at: "2026-10-07T11:00:00Z" } }), ctx), enabled: false };
  const later = { now: new Date("2026-10-08T10:00:00Z"), otherNames: [] };
  const again = applyTaskPatch(task, { schedule: { kind: "once", at: "2026-10-09T09:00:00Z" } }, later);
  assert.equal(again.enabled, true);
  assert.equal(again.lastScheduledFor, later.now.toISOString());
  // An explicit choice in the same edit wins.
  assert.equal(applyTaskPatch(task, { schedule: { kind: "once", at: "2026-10-09T09:00:00Z" }, enabled: false }, later).enabled, false);
  // Moving it to a recurring schedule revives it as well; to manual-only it stays off.
  assert.equal(applyTaskPatch(task, { schedule: { kind: "cron", expr: "0 9 * * *", timezone: "UTC" } }, later).enabled, true);
  assert.equal(applyTaskPatch(task, { schedule: { kind: "manual" } }, later).enabled, false);
});

test("a task the system paused is not revived by an edit, only by resuming it", (t) => {
  const task = { ...buildTask(base(dir(t)), ctx), enabled: false, autoPausedReason: "boom", consecutiveFailures: 5 };
  const later = { now: new Date("2026-10-08T10:00:00Z"), otherNames: [] };
  assert.equal(applyTaskPatch(task, { schedule: { kind: "cron", expr: "0 18 * * *", timezone: "UTC" } }, later).enabled, false);
});

test("validation errors carry a key and parameters for the reader's language", (t) => {
  const key = (fn) => { try { fn(); } catch (error) { return { key: error.key, params: error.params }; } return null; };
  const cwd = dir(t);
  assert.deepEqual(key(() => buildTask(base(cwd, { schedule: { kind: "cron", expr: "* * * * *" } }), ctx)), { key: "scheduled.error.interval", params: { minutes: 5 } });
  assert.deepEqual(key(() => buildTask(base(cwd, { schedule: { kind: "cron", expr: "nonsense nonsense nonsense nonsense nonsense" } }), ctx)).key, "scheduled.error.cronInvalid");
  assert.equal(key(() => buildTask(base(cwd, { schedule: { kind: "cron", expr: "0 9 * * *", timezone: "Nope/Zone" } }), ctx)).key, "scheduled.error.timezone");
  assert.equal(key(() => buildTask(base(cwd, { schedule: { kind: "cron", expr: "0 9 *" } }), ctx)).key, "scheduled.error.cronFields");
  assert.equal(key(() => buildTask(base(cwd, { schedule: { kind: "once", at: "2026-10-07T09:00:00Z" } }), ctx)).key, "scheduled.error.oncePast");
  assert.equal(key(() => buildTask(base(cwd, { toolPreset: "full" }), ctx)).key, "scheduled.error.writeAck");
  assert.deepEqual(key(() => buildTask(base(cwd, { name: "Daily review" }), { now, otherNames: ["daily review"] })), { key: "scheduled.error.nameTaken", params: { name: "Daily review" } });
  assert.equal(key(() => buildTask(base(join(cwd, "missing")), ctx)).key, "scheduled.error.cwdMissing");
});

test("moving to a writing preset needs the acknowledgement, staying on it does not", (t) => {
  const readOnly = buildTask(base(dir(t)), ctx);
  assert.throws(() => applyTaskPatch(readOnly, { toolPreset: "full" }, ctx), /acknowledgeUnattendedWrites/);
  const full = applyTaskPatch(readOnly, { toolPreset: "full", acknowledgeUnattendedWrites: true }, ctx);
  assert.equal(full.toolPreset, "full");
  assert.equal(applyTaskPatch(full, { toolPreset: "full", prompt: "x" }, ctx).toolPreset, "full");
});

test("null clears optional fields", (t) => {
  const task = buildTask(base(dir(t), { description: "d", model: { provider: "a", modelId: "b" }, thinkingLevel: "high" }), ctx);
  const next = applyTaskPatch(task, { description: null, model: null, thinkingLevel: null }, ctx);
  assert.equal(next.description, undefined);
  assert.equal(next.model, undefined);
  assert.equal(next.thinkingLevel, undefined);
});
