import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { decideSlot } = await createJiti(import.meta.url).import("./catch-up.ts");

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function task(schedule) {
  return {
    id: "00000000-0000-4000-8000-000000000001", name: "t", prompt: "p", cwd: "/", schedule,
    toolPreset: "read-only", maxDurationMin: 30, enabled: true,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", consecutiveFailures: 0,
  };
}
const daily = task({ kind: "cron", expr: "0 9 * * *", timezone: "UTC" });
const d = (iso) => new Date(iso);

test("manual tasks never fire on their own", () => {
  assert.deepEqual(decideSlot(task({ kind: "manual" }), d("2026-10-07T12:00:00Z"), d("2026-10-01T00:00:00Z")), { action: "none" });
});

test("nothing is due before the first slot after `since`", () => {
  assert.equal(decideSlot(daily, d("2026-10-07T08:59:00Z"), d("2026-10-07T00:00:00Z")).action, "none");
});

test("a slot inside the grace period is an on-time run", () => {
  const decision = decideSlot(daily, d("2026-10-07T09:01:00Z"), d("2026-10-06T09:00:00Z"));
  assert.equal(decision.action, "fire");
  assert.equal(decision.trigger, "schedule");
  assert.equal(decision.scheduledFor.toISOString(), "2026-10-07T09:00:00.000Z");
  assert.equal(decision.skippedSlots, 0);
});

test("a slot already handled is not fired twice", () => {
  assert.equal(decideSlot(daily, d("2026-10-07T09:01:00Z"), d("2026-10-07T09:00:00Z")).action, "none");
});

test("a late slot becomes one catch-up run and counts the older slots it replaces", () => {
  // Machine asleep from 08:00 on the 3rd to 14:00 on the 7th: slots on 3rd..7th at 09:00,
  // the newest one runs and the three before it (4th, 5th, 6th) are dropped.
  const decision = decideSlot(daily, d("2026-10-07T14:00:00Z"), d("2026-10-03T09:00:00Z"));
  assert.equal(decision.action, "fire");
  assert.equal(decision.trigger, "catch-up");
  assert.equal(decision.scheduledFor.toISOString(), "2026-10-07T09:00:00.000Z");
  assert.equal(decision.skippedSlots, 3);
});

test("only the newest slot runs after a long absence", () => {
  const decision = decideSlot(daily, d("2026-10-20T12:00:00Z"), d("2026-10-01T09:00:00Z"));
  assert.equal(decision.action, "fire");
  assert.equal(decision.trigger, "catch-up");
  assert.equal(decision.scheduledFor.toISOString(), "2026-10-20T09:00:00.000Z");
  assert.equal(decision.skippedSlots, 18);
});

test("a due slot beyond the catch-up window is dropped and recorded", () => {
  const monthly = task({ kind: "cron", expr: "0 9 1 * *", timezone: "UTC" });
  const decision = decideSlot(monthly, d("2026-10-20T12:00:00Z"), d("2026-09-01T09:00:00Z"));
  assert.equal(decision.action, "drop");
  assert.equal(decision.scheduledFor.toISOString(), "2026-10-01T09:00:00.000Z");
  assert.equal(decision.skippedSlots, 1);
  assert.ok(Date.parse("2026-10-20T12:00:00Z") - decision.scheduledFor.getTime() > 7 * DAY);
});

test("a one-time task fires once its time passes and not again", () => {
  const once = task({ kind: "once", at: "2026-10-07T15:00:00.000Z" });
  assert.equal(decideSlot(once, d("2026-10-07T14:59:00Z"), d("2026-10-07T10:00:00Z")).action, "none");
  const fired = decideSlot(once, d("2026-10-07T15:00:30Z"), d("2026-10-07T10:00:00Z"));
  assert.equal(fired.action, "fire");
  assert.equal(fired.trigger, "schedule");
  assert.equal(decideSlot(once, d("2026-10-07T16:00:00Z"), d("2026-10-07T15:00:00Z")).action, "none");
  // The app was closed over the slot: still run it, as a catch-up.
  assert.equal(decideSlot(once, d("2026-10-07T20:00:00Z"), d("2026-10-07T10:00:00Z")).trigger, "catch-up");
});
