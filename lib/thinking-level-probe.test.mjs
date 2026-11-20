import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  mapWithConcurrency,
  payloadCarriesValue,
  probeFailureStatus,
  probeModelFor,
  probeValueFor,
  summarizeThinkingProbe,
} = await jiti.import("./thinking-level-probe.ts");

test("probeValueFor sends the mapped value, the level's name by default, nothing for a disabled level", () => {
  assert.equal(probeValueFor("medium", undefined), "medium");
  assert.equal(probeValueFor("medium", { medium: "high" }), "high");
  assert.equal(probeValueFor("medium", { medium: "" }), "medium");
  assert.equal(probeValueFor("medium", { medium: null }), null);
});

test("probeModelFor gives the level an explicit entry so pi's clamp keeps xhigh/max", () => {
  const model = { id: "m", thinkingLevelMap: { low: "low" } };
  assert.deepEqual(probeModelFor(model, "max", "max").thinkingLevelMap, { low: "low", max: "max" });
  assert.deepEqual(model.thinkingLevelMap, { low: "low" });
});

test("payloadCarriesValue matches an exact string anywhere in the payload", () => {
  assert.equal(payloadCarriesValue({ reasoning: { effort: "high" } }, "high"), true);
  assert.equal(payloadCarriesValue({ messages: [{ content: "Reply high" }] }, "high"), false);
  assert.equal(payloadCarriesValue({ enable_thinking: true }, "high"), false);
});

test("probeFailureStatus falls back to the error text's leading status", () => {
  assert.equal(probeFailureStatus(422, "400 data"), 422);
  assert.equal(probeFailureStatus(undefined, "400 data: {\"error\":{}}"), 400);
  assert.equal(probeFailureStatus(undefined, "Request timed out"), undefined);
});

test("summarizeThinkingProbe keeps what the probe cannot judge", () => {
  const summary = summarizeThinkingProbe({ low: "low" }, [
    { level: "minimal", value: "minimal", outcome: "inconclusive" },
    { level: "low", value: "low", outcome: "accepted" },
    { level: "medium", value: "medium", outcome: "rejected" },
    { level: "high", value: "high", outcome: "accepted" },
    { level: "xhigh", value: "xhigh", outcome: "not-sent" },
    { level: "max", value: "max", outcome: "accepted" },
  ]);
  assert.deepEqual(summary.suggestedMap, { low: "low", medium: null, max: "max" });
  assert.equal(summary.changed, true);
  assert.equal(summary.applicable, true);
});

test("summarizeThinkingProbe reports no change when the map already matches", () => {
  const summary = summarizeThinkingProbe({ medium: null }, [
    { level: "medium", value: null, outcome: "skipped" },
    { level: "high", value: "high", outcome: "accepted" },
  ]);
  assert.equal(summary.changed, false);
});

test("mapWithConcurrency keeps order and the limit", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
  assert.equal(peak, 2);
});
