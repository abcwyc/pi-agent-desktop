import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { selectableThinkingLevels } = await jiti.import("./thinking-level-options.ts");
const levels = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

test("explicit effort mappings only expose configured and supported levels", () => {
  assert.deepEqual(selectableThinkingLevels(levels, levels.slice(1), {
    minimal: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
  }), ["minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(selectableThinkingLevels(levels, levels.slice(1), { off: null, minimal: "none", medium: "medium", xhigh: "xhigh" }), ["minimal", "medium", "xhigh"]);
  assert.deepEqual(selectableThinkingLevels(levels, ["off", "low"], { off: "none", low: "low", max: "max" }), ["off", "low"]);
});

test("models without an explicit map retain the existing auto and SDK-supported choices", () => {
  assert.deepEqual(selectableThinkingLevels(levels, ["off", "low"], null), ["auto", "off", "low"]);
  assert.deepEqual(selectableThinkingLevels(levels, null, null), levels);
});
