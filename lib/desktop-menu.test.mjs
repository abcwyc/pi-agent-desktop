import assert from "node:assert/strict";
import test from "node:test";
import { tidyMenuEntries, toTauriMenuItems } from "./desktop-menu-model.ts";

test("items carry text, enabled state, and an action that calls onSelect", () => {
  let called = 0;
  const [item] = toTauriMenuItems([{ label: "Rename", onSelect: () => { called += 1; } }]);
  assert.equal(item.text, "Rename");
  assert.equal(item.enabled, true);
  assert.equal("checked" in item, false);
  item.action("id");
  assert.equal(called, 1);
});

test("disabled and checked map to enabled:false and checked", () => {
  const [off, on, off2] = toTauriMenuItems([
    { label: "a", disabled: true },
    { label: "b", checked: true },
    { label: "c", checked: false },
  ]);
  assert.equal(off.enabled, false);
  assert.equal(on.checked, true);
  assert.equal(off2.checked, false);
});

test("separators, predefined items and submenus use the shapes Menu.new accepts", () => {
  const items = toTauriMenuItems([
    { kind: "separator" },
    { kind: "predefined", item: "Copy" },
    { kind: "submenu", label: "More", items: [{ label: "x" }] },
  ]);
  assert.deepEqual(items[0], { item: "Separator" });
  assert.deepEqual(items[1], { item: "Copy" });
  assert.equal(items[2].text, "More");
  assert.equal(items[2].items.length, 1);
});

test("tidyMenuEntries drops leading, trailing and repeated separators", () => {
  const sep = { kind: "separator" };
  const out = tidyMenuEntries([sep, { label: "a" }, sep, sep, { label: "b" }, sep]);
  assert.deepEqual(out.map((e) => e.kind ?? e.label), ["a", "separator", "b"]);
});
