import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { takeHighlightBudget, waitForHighlight } = await jiti.import("./highlight-queue.ts");

test("a task highlights its first fences up to the budget, the next task starts afresh", async () => {
  assert.equal(takeHighlightBudget(1_500), true);
  assert.equal(takeHighlightBudget(1_000), false);
  assert.equal(takeHighlightBudget(400), true);
  await delay(5);
  assert.equal(takeHighlightBudget(1_900), true);
  await delay(5);
});

async function until(condition) {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > 2_000) throw new Error("timed out");
    await delay(5);
  }
}

test("waiting fences get their colors one per slice, newest first, and a cancel drops one", async () => {
  const shown = [];
  waitForHighlight(() => shown.push("top"));
  const cancel = waitForHighlight(() => shown.push("middle"));
  waitForHighlight(() => shown.push("bottom"));
  cancel();
  assert.deepEqual(shown, []);
  await until(() => shown.length > 0);
  assert.deepEqual(shown, ["bottom"]);
  await until(() => shown.length > 1);
  assert.deepEqual(shown, ["bottom", "top"]);
  await delay(120);
  assert.deepEqual(shown, ["bottom", "top"]);
});
