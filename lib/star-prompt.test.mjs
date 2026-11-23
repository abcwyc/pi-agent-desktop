import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
};

const jiti = createJiti(import.meta.url);
const {
  STAR_PROMPT_MIN_AGE_MS,
  isComplexRun,
  loadStarPromptState,
  resolveStarPrompt,
  shouldShowStarPrompt,
} = await jiti.import("./star-prompt.ts");

const DAY = 24 * 60 * 60 * 1000;

test("a complex run used many tools, or ran long with some tools, and was not stopped", () => {
  assert.equal(isComplexRun({ aborted: false, toolCalls: 8, durationMs: 1000 }), true);
  assert.equal(isComplexRun({ aborted: false, toolCalls: 3, durationMs: 3 * 60 * 1000 }), true);
  assert.equal(isComplexRun({ aborted: false, toolCalls: 2, durationMs: 30 * 60 * 1000 }), false);
  assert.equal(isComplexRun({ aborted: false, toolCalls: 7, durationMs: 60 * 1000 }), false);
  assert.equal(isComplexRun({ aborted: true, toolCalls: 50, durationMs: 30 * 60 * 1000 }), false);
  assert.equal(isComplexRun({ aborted: false }), false);
});

test("the prompt waits seven days from first launch and shows only once", () => {
  storage.clear();
  const start = 1_000_000;
  const complex = { aborted: false, toolCalls: 12, durationMs: 60_000 };

  const first = loadStarPromptState(start);
  assert.equal(first.firstSeenAt, start);
  // A later load keeps the original first-seen time.
  assert.equal(loadStarPromptState(start + DAY).firstSeenAt, start);

  assert.equal(shouldShowStarPrompt(first, complex, start + 6 * DAY), false);
  assert.equal(shouldShowStarPrompt(first, complex, start + STAR_PROMPT_MIN_AGE_MS), true);
  assert.equal(shouldShowStarPrompt(first, { aborted: false, toolCalls: 1 }, start + 8 * DAY), false);

  resolveStarPrompt("dismissed", start + 8 * DAY);
  const resolved = loadStarPromptState(start + 9 * DAY);
  assert.equal(resolved.outcome, "dismissed");
  assert.equal(resolved.firstSeenAt, start);
  assert.equal(shouldShowStarPrompt(resolved, complex, start + 30 * DAY), false);
});

test("corrupt stored state starts the clock again instead of throwing", () => {
  storage.clear();
  storage.set("pi-web:star-prompt", "{not json");
  assert.equal(loadStarPromptState(42).firstSeenAt, 42);
  storage.set("pi-web:star-prompt", JSON.stringify({ firstSeenAt: "x" }));
  assert.equal(loadStarPromptState(43).firstSeenAt, 43);
});
