import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  UNATTRIBUTED_USAGE_KEY,
  getUsageCostBreakdown,
  mergeUsageBreakdown,
  shouldShowUsageBreakdown,
} = await jiti.import("./usage-breakdown.ts");

const usage = (cost, tokens = 10) => ({
  input: tokens, output: 0, cacheRead: 0, cacheWrite: 0,
  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const assistant = (provider, model, cost, extra = {}) => ({
  role: "assistant", content: [], provider, model, usage: usage(cost), ...extra,
});
const message = (msg) => ({ type: "message", id: Math.random().toString(16).slice(2), parentId: null, timestamp: "t", message: msg });

test("groups cost by the model that answered, like pi's /session", () => {
  const breakdown = getUsageCostBreakdown([
    message({ role: "user", content: "hi" }),
    message(assistant("anthropic", "claude-opus-5-5", 0.30)),
    // A virtual or routing model: the response names the model that really answered.
    message(assistant("openrouter", "auto", 0.05, { responseModel: "openai/gpt-6-luna" })),
    message(assistant("anthropic", "claude-opus-5-5", 0.20)),
    { type: "usage", id: "w", parentId: null, timestamp: "t", kind: "cache_warm", provider: "anthropic", model: "claude-opus-5-5", usage: usage(0.01) },
    { type: "compaction", id: "c", parentId: null, timestamp: "t", summary: "s", firstKeptEntryId: "x", tokensBefore: 1, usage: usage(0.02) },
    message({ role: "toolResult", toolCallId: "t", content: [], usage: usage(0.04) }),
  ]);

  assert.deepEqual(breakdown.map((entry) => [entry.key, Number(entry.cost.toFixed(2))]), [
    ["anthropic/claude-opus-5-5", 0.51],
    [UNATTRIBUTED_USAGE_KEY, 0.06],
    ["openrouter/openai/gpt-6-luna", 0.05],
  ]);
});

test("drops models with neither cost nor tokens", () => {
  assert.deepEqual(getUsageCostBreakdown([message({ ...assistant("p", "m", 0, {}), usage: usage(0, 0) })]), []);
});

test("advances the file's breakdown by what streamed in since it was read", () => {
  const loaded = [assistant("anthropic", "claude-opus-5-5", 0.10)];
  const current = [...loaded, assistant("openai", "gpt-6-luna", 0.04)];
  const merged = mergeUsageBreakdown([{ key: "anthropic/claude-opus-5-5", cost: 0.50, tokens: 100 }], loaded, current);

  assert.deepEqual(merged.map((entry) => [entry.key, Number(entry.cost.toFixed(2))]), [
    ["anthropic/claude-opus-5-5", 0.5],
    ["openai/gpt-6-luna", 0.04],
  ]);
});

test("a single row is shown only when it names a model other than the selected one", () => {
  const one = [{ key: "anthropic/claude-opus-5-5", cost: 1, tokens: 1 }];
  assert.equal(shouldShowUsageBreakdown(one, "anthropic/claude-opus-5-5"), false);
  assert.equal(shouldShowUsageBreakdown(one, "router/auto"), true);
  assert.equal(shouldShowUsageBreakdown([...one, { key: "x/y", cost: 0, tokens: 1 }], "anthropic/claude-opus-5-5"), true);
  assert.equal(shouldShowUsageBreakdown([], "a/b"), false);
});
