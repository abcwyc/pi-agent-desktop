import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const cron = await createJiti(import.meta.url).import("./cron.ts");

const at = (iso) => new Date(iso);

test("nextCronRuns honours the timezone", () => {
  const runs = cron.nextCronRuns("0 9 * * 1-5", "Asia/Shanghai", 2, at("2026-10-07T00:00:00Z"));
  assert.deepEqual(runs.map((d) => d.toISOString()), ["2026-10-07T01:00:00.000Z", "2026-10-08T01:00:00.000Z"]);
});

test("weekday expressions skip the weekend", () => {
  // 2026-10-09 is a Friday.
  const [first, second] = cron.nextCronRuns("0 9 * * 1-5", "UTC", 2, at("2026-10-09T10:00:00Z"));
  assert.equal(first.toISOString(), "2026-10-12T09:00:00.000Z");
  assert.equal(second.toISOString(), "2026-10-13T09:00:00.000Z");
});

test("previousCronRun includes a slot that is exactly now", () => {
  const exact = cron.previousCronRun("0 9 * * *", "UTC", at("2026-10-07T09:00:00Z"));
  assert.equal(exact.toISOString(), "2026-10-07T09:00:00.000Z");
  const fractional = cron.previousCronRun("0 9 * * *", "UTC", at("2026-10-07T09:00:00.500Z"));
  assert.equal(fractional.toISOString(), "2026-10-07T09:00:00.000Z");
  const before = cron.previousCronRun("0 9 * * *", "UTC", at("2026-10-07T08:59:59.500Z"));
  assert.equal(before.toISOString(), "2026-10-06T09:00:00.000Z");
});

test("validateCron rejects bad expressions, wrong field counts and unknown timezones", () => {
  assert.throws(() => cron.validateCron("nonsense", "UTC"), /exactly five fields|invalid cron/);
  assert.throws(() => cron.validateCron("0 0 9 * * *", "UTC"), /exactly five fields/);
  assert.throws(() => cron.validateCron("0 9 * * *", "Nope/Zone"), /invalid timezone/);
  assert.doesNotThrow(() => cron.validateCron("0 9 * * *", "UTC"));
});

test("validateCron enforces the minimum interval", () => {
  assert.throws(() => cron.validateCron("* * * * *", "UTC"), /at least 5 minutes/);
  assert.throws(() => cron.validateCron("*/4 * * * *", "UTC"), /at least 5 minutes/);
  assert.throws(() => cron.validateCron("0,3 * * * *", "UTC"), /at least 5 minutes/);
  assert.doesNotThrow(() => cron.validateCron("*/5 * * * *", "UTC"));
  assert.doesNotThrow(() => cron.validateCron("0 * * * *", "UTC"));
});

test("countCronSlotsBetween counts slots strictly between the bounds", () => {
  // Hourly: 10:00 and 11:00 sit strictly between 09:00 and 12:00.
  assert.equal(cron.countCronSlotsBetween("0 * * * *", "UTC", at("2026-10-07T09:00:00Z"), at("2026-10-07T12:00:00Z")), 2);
  assert.equal(cron.countCronSlotsBetween("0 * * * *", "UTC", at("2026-10-07T09:30:00Z"), at("2026-10-07T10:00:00Z")), 0);
});
