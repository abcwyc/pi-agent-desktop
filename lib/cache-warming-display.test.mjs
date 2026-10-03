import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { cacheWarmingRows, formatWarmingDelay } = await jiti.import("./cache-warming-display.ts");

// Echo keys and params so the rows show which message each line uses.
const t = (key, params) => (params ? `${key}${JSON.stringify(params)}` : key);
const decision = (overrides = {}) => ({
  phase: "idle", warmCost: 0.004, missCost: 0.12, continuationProbability: 0.6,
  expectedSavings: 0.068, economicsAvailable: true, action: "warm", ...overrides,
});

test("formats delays like pi's /session", () => {
  assert.equal(formatWarmingDelay(0), "0s");
  assert.equal(formatWarmingDelay(61_000), "1m1s");
  assert.equal(formatWarmingDelay(3_600_000), "1h");
  assert.equal(formatWarmingDelay(1_500), "2s");
});

test("a session without a warmer says so", () => {
  assert.deepEqual(cacheWarmingRows({ mode: "streaming" }, t), [
    ["session.cacheWarmingMode", "session.cacheWarmingModeStreaming"],
    ["session.cacheWarmingStatus", "session.cacheWarmingUnavailable"],
  ]);
});

test("inactive without economics shows pi's reason", () => {
  const rows = cacheWarmingRows({ mode: "off", status: { state: "inactive", reason: "mode is off" } }, t);
  assert.deepEqual(rows[1], ["session.cacheWarmingStatus", 'session.cacheWarmingInactive{"reason":"mode is off"}']);
  assert.equal(rows.length, 2);
});

test("a scheduled refresh shows the countdown and the economics behind it", () => {
  const rows = cacheWarmingRows(
    { mode: "idle", status: { state: "scheduled", nextWarmAt: 10_000 + 90_000, decision: decision() } },
    t,
    10_000,
  );
  assert.deepEqual(rows, [
    ["session.cacheWarmingMode", "session.cacheWarmingModeIdle"],
    ["session.cacheWarmingStatus", 'session.cacheWarmingNext{"time":"1m30s"}'],
    ["session.cacheWarmingSavings", "$0.068 → session.cacheWarmingWarm"],
    ["session.cacheMissPenalty", "$0.120"],
    ["session.cacheRefreshCost", "$0.004"],
  ]);
});

test("a stop decided by an extension is labelled as such", () => {
  const rows = cacheWarmingRows(
    { mode: "streaming", status: { state: "inactive", extensionOverride: true, decision: decision({ action: "stop" }) } },
    t,
  );
  assert.deepEqual(rows[1], ["session.cacheWarmingStatus", "session.cacheWarmingStopped"]);
  assert.equal(rows[2][1], "$0.068 → session.cacheWarmingStop (session.cacheWarmingOverride)");
});
