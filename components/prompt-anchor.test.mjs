import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { nextPromptAnchorSpacerHeight } = await jiti.import("./prompt-anchor.ts");

test("long histories converge after inserting the spacer", () => {
  const first = nextPromptAnchorSpacerHeight(1000032, 1000000, 600, 0);
  assert.equal(first, 632);
  assert.equal(nextPromptAnchorSpacerHeight(1000032, 1000000 + first, 600, first), first);
});

test("subpixel measurement noise does not cause another layout update", () => {
  assert.equal(nextPromptAnchorSpacerHeight(701.2, 1300, 600, 300), 300);
  assert.equal(nextPromptAnchorSpacerHeight(699.8, 1300, 600, 300), 300);
});
