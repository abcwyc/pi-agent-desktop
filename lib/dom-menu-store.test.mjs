import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { closeDomMenu, domMenuEntries, getDomMenu, openDomMenu, subscribeDomMenu } = await jiti.import("./dom-menu-store.ts");

const sep = { kind: "separator" };

test("predefined items are dropped and the separators around them tidied", () => {
  const out = domMenuEntries([
    { kind: "predefined", item: "Copy" },
    sep,
    { label: "a" },
    sep,
    { kind: "predefined", item: "Paste" },
    sep,
  ]);
  assert.deepEqual(out.map((e) => e.kind ?? e.label), ["a"]);
});

test("open publishes the menu to subscribers and close clears it", () => {
  let calls = 0;
  const off = subscribeDomMenu(() => { calls += 1; });
  openDomMenu([{ label: "Open" }], { x: 10, y: 20 });
  assert.equal(calls, 1);
  assert.deepEqual(getDomMenu()?.at, { x: 10, y: 20 });
  closeDomMenu();
  assert.equal(calls, 2);
  assert.equal(getDomMenu(), null);
  closeDomMenu();
  assert.equal(calls, 2, "closing a closed menu does not notify");
  off();
});

test("a menu with nothing renderable is not opened", () => {
  openDomMenu([{ kind: "predefined", item: "Copy" }], { x: 0, y: 0 });
  assert.equal(getDomMenu(), null);
});
