import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Execute the real entrance effect, as the prompt-anchor geometry test does.
// No model request or private session data is needed.
const source = ts.createSourceFile("ChatWindow.tsx", readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let body;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useLayoutEffect") {
    const callback = node.arguments[0];
    if (callback?.getText(source).includes("const pending = pendingMessageEntrance.current")) body = callback.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(body, "entrance effect must exist");
const callback = ts.transpileModule(`(${body})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
function effect(pending, count, reduced = false) {
  const bubble = { dataset: {} };
  const ref = { current: pending };
  const run = new Function("pendingMessageEntrance", "messages", "messageContentRef", "window", `return ${callback}`)(
    ref, Array(count), { current: { querySelectorAll: () => [bubble] } }, { matchMedia: () => ({ matches: reduced }) },
  );
  run();
  return { bubble, ref, run };
}

test("history loads never arm bubble motion", () => {
  assert.deepEqual(effect(null, 100).bubble.dataset, {});
});
test("local submission animates once after its message appears", () => {
  const pending = { count: 5, at: Date.now() };
  const waiting = effect(pending, 5);
  assert.deepEqual(waiting.bubble.dataset, {});
  assert.equal(waiting.ref.current, pending);
  const sent = effect(pending, 6);
  assert.equal(sent.bubble.dataset.messageEnter, "grow");
  assert.equal(sent.ref.current, null);
  delete sent.bubble.dataset.messageEnter;
  sent.run();
  assert.deepEqual(sent.bubble.dataset, {}, "reconciliation does not replay animation");
});
test("reduced motion and expired submissions do not animate", () => {
  assert.deepEqual(effect({ count: 0, at: Date.now() }, 1, true).bubble.dataset, {});
  assert.deepEqual(effect({ count: 0, at: Date.now() - 16000 }, 1).bubble.dataset, {});
});
