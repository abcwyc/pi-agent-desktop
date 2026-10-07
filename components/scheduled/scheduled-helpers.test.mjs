import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../..", import.meta.url).pathname.replace(/\/$/, "") } });
const h = await jiti.import("./scheduled-helpers.ts");

// A translator that exposes the key and parameters so the choice of wording is visible.
const t = (key, params) => (params ? `${key}${JSON.stringify(params)}` : key);

const base = {
  id: "task", name: "n", prompt: "p", cwd: "/", schedule: { kind: "manual" }, toolPreset: "read-only",
  maxDurationMin: 30, enabled: true, createdAt: "", updatedAt: "", consecutiveFailures: 0,
  nextRunAt: null, lastRun: null, unreadRuns: 0,
};

test("schedules are described with the wording that matches their preset", () => {
  const cron = (expr) => ({ kind: "cron", expr, timezone: "UTC" });
  assert.equal(h.describeSchedule({ kind: "manual" }, t, "en"), "scheduled.describe.manual");
  assert.equal(h.describeSchedule(cron("5 * * * *"), t, "en"), 'scheduled.describe.hourly{"minute":"05"}');
  assert.equal(h.describeSchedule(cron("0 9 * * *"), t, "en"), 'scheduled.describe.daily{"time":"09:00"}');
  assert.equal(h.describeSchedule(cron("30 8 * * 1-5"), t, "en"), 'scheduled.describe.weekdays{"time":"08:30"}');
  assert.equal(h.describeSchedule(cron("0 9 * * 1"), t, "en"), 'scheduled.describe.weekly{"day":"Monday","time":"09:00"}');
  assert.equal(h.describeSchedule(cron("*/15 * * * *"), t, "en"), 'scheduled.describe.custom{"expr":"*/15 * * * *"}');
});

test("weekday names follow the locale", () => {
  const schedule = { kind: "cron", expr: "0 9 * * 0", timezone: "UTC" };
  assert.match(h.describeSchedule(schedule, t, "en"), /Sunday/);
  assert.match(h.describeSchedule(schedule, t, "zh-CN"), /星期日/);
});

test("task status prefers running, then attention, then enabled state", () => {
  const none = new Set();
  assert.equal(h.taskStatus(base, none), "manual");
  assert.equal(h.taskStatus({ ...base, schedule: { kind: "cron", expr: "0 9 * * *", timezone: "UTC" } }, none), "active");
  assert.equal(h.taskStatus({ ...base, enabled: false }, none), "paused");
  assert.equal(h.taskStatus({ ...base, enabled: false, autoPausedReason: "x" }, none), "attention");
  assert.equal(h.taskStatus({ ...base, enabled: false, autoPausedReason: "x" }, new Set(["task"])), "running");
  assert.equal(h.taskStatus({ ...base, lastRun: { runId: "r", taskId: "task", trigger: "manual", status: "running" } }, none), "running");
  assert.equal(h.taskStatus({ ...base, enabled: false, schedule: { kind: "once", at: "2026-10-07T09:00:00Z" }, lastRun: { runId: "r", taskId: "task", trigger: "schedule", status: "succeeded" } }, none), "done");
});

test("durations read naturally", () => {
  assert.equal(h.formatDuration(4200), "4s");
  assert.equal(h.formatDuration(185_000), "3m 05s");
  assert.equal(h.formatDuration(3_720_000), "1h 02m");
  assert.equal(h.formatDuration(-5), "0s");
  assert.equal(h.runDuration({ startedAt: "2026-10-07T09:00:00Z", endedAt: "2026-10-07T09:00:42Z" }), 42_000);
  assert.equal(h.runDuration({ startedAt: "2026-10-07T09:00:00Z" }), null);
});

test("only a finished run with a session the user has not opened is unread", () => {
  const run = { runId: "r", taskId: "t", trigger: "manual", status: "succeeded", sessionId: "s" };
  assert.equal(h.isUnread(run), true);
  assert.equal(h.isUnread({ ...run, seenAt: "2026-10-07T10:00:00Z" }), false);
  assert.equal(h.isUnread({ ...run, status: "running" }), false);
  assert.equal(h.isUnread({ ...run, status: "skipped" }), false);
  assert.equal(h.isUnread({ ...run, sessionId: undefined }), false);
});

test("local datetime values round-trip through an instant", () => {
  const iso = "2026-10-07T09:30:00.000Z";
  assert.equal(h.fromLocalInputValue(h.toLocalInputValue(iso)), iso);
  assert.equal(h.fromLocalInputValue("not a date"), null);
});

test("only the presets that can change files are flagged as writing", () => {
  assert.deepEqual(["none", "read-only", "default", "full"].map(h.canWrite), [false, false, true, true]);
});
