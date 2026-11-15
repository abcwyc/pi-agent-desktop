import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { calendarRuns, plannedRuns, MAX_PLANNED_PER_TASK } = await createJiti(import.meta.url).import("./calendar.ts");

const ms = (iso) => Date.parse(iso);
const task = (schedule, extra = {}) => ({
  id: "t", name: "Brief", prompt: "p", cwd: "/code", schedule, toolPreset: "read-only", maxDurationMin: 30,
  enabled: true, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", consecutiveFailures: 0, ...extra,
});

test("planned slots start at now, stop at the range end, and include a slot exactly at now", () => {
  const daily = task({ kind: "cron", expr: "0 9 * * *", timezone: "UTC" });
  const slots = plannedRuns(daily, ms("2026-11-10T00:00:00Z"), ms("2026-11-18T00:00:00Z"), ms("2026-11-15T09:00:00Z"));
  assert.deepEqual(slots.map((slot) => new Date(slot.at).toISOString()), [
    "2026-11-15T09:00:00.000Z", "2026-11-16T09:00:00.000Z", "2026-11-17T09:00:00.000Z",
  ]);
});

test("disabled, manual and past one-off tasks plan nothing; a future one-off plans once", () => {
  const from = ms("2026-11-01T00:00:00Z");
  const to = ms("2026-12-01T00:00:00Z");
  const now = ms("2026-11-15T00:00:00Z");
  assert.deepEqual(plannedRuns(task({ kind: "cron", expr: "0 9 * * *", timezone: "UTC" }, { enabled: false }), from, to, now), []);
  assert.deepEqual(plannedRuns(task({ kind: "manual" }), from, to, now), []);
  assert.deepEqual(plannedRuns(task({ kind: "once", at: "2026-11-10T00:00:00Z" }), from, to, now), []);
  assert.deepEqual(plannedRuns(task({ kind: "once", at: "2026-11-20T08:00:00Z" }), from, to, now), [{ taskId: "t", at: ms("2026-11-20T08:00:00Z") }]);
  assert.deepEqual(plannedRuns(task({ kind: "cron", expr: "not a cron", timezone: "UTC" }), from, to, now), []);
});

test("a frequent schedule is capped", () => {
  const every5 = task({ kind: "cron", expr: "*/5 * * * *", timezone: "UTC" });
  const slots = plannedRuns(every5, ms("2026-11-01T00:00:00Z"), ms("2026-12-01T00:00:00Z"), ms("2026-11-01T00:00:00Z"));
  assert.equal(slots.length, MAX_PLANNED_PER_TASK);
});

test("runs in range keep their start (or slot) time; skipped and out-of-range runs are dropped", () => {
  const runs = calendarRuns([
    { runId: "a", taskId: "t", trigger: "schedule", status: "succeeded", startedAt: "2026-11-14T09:00:05Z", endedAt: "2026-11-14T09:01:00Z", sessionId: "s" },
    { runId: "b", taskId: "t", trigger: "schedule", status: "skipped", scheduledFor: "2026-11-14T10:00:00Z" },
    { runId: "c", taskId: "t", trigger: "schedule", status: "failed", scheduledFor: "2026-11-14T11:00:00Z", error: "boom", errorCode: "time-limit" },
    { runId: "d", taskId: "t", trigger: "schedule", status: "succeeded", startedAt: "2026-10-01T09:00:00Z" },
    { runId: "e", taskId: "t", trigger: "schedule", status: "succeeded", sessionId: "archived" },
  ], ms("2026-11-14T00:00:00Z"), ms("2026-11-15T00:00:00Z"));
  assert.deepEqual(runs, [
    { runId: "a", taskId: "t", at: ms("2026-11-14T09:00:05Z"), status: "succeeded", endedAt: ms("2026-11-14T09:01:00Z"), sessionId: "s" },
    { runId: "c", taskId: "t", at: ms("2026-11-14T11:00:00Z"), status: "failed", error: "boom", errorCode: "time-limit" },
  ]);
});
