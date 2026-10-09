import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createNativeMenuItems, tidyMenuEntries } from "./desktop-menu-model.ts";

/** Records what the model asks the factory to create; every product is a tagged plain object. */
function recordingFactory() {
  return {
    separator: async () => ({ kind: "separator" }),
    predefined: async (item, text) => ({ kind: "predefined", item, text }),
    item: async (options) => ({ kind: options.checked === undefined ? "item" : "check", ...options }),
    submenu: async (options) => ({ kind: "submenu", ...options }),
  };
}

test("items carry text, enabled state, and an action that calls onSelect", async () => {
  let called = 0;
  const [item] = await createNativeMenuItems([{ label: "Rename", onSelect: () => { called += 1; } }], recordingFactory());
  assert.equal(item.kind, "item");
  assert.equal(item.text, "Rename");
  assert.equal(item.enabled, true);
  assert.equal("checked" in item, false);
  item.action();
  assert.equal(called, 1);
});

test("disabled and checked map to enabled:false and a check item", async () => {
  const [off, on, off2] = await createNativeMenuItems([
    { label: "a", disabled: true },
    { label: "b", checked: true },
    { label: "c", checked: false },
  ], recordingFactory());
  assert.equal(off.enabled, false);
  assert.equal(on.kind, "check");
  assert.equal(on.checked, true);
  assert.equal(off2.checked, false);
});

test("separators, predefined items and submenus are built through the factory, children first", async () => {
  const items = await createNativeMenuItems([
    { kind: "separator" },
    { kind: "predefined", item: "Copy" },
    { kind: "submenu", label: "More", items: [{ label: "x" }] },
  ], recordingFactory());
  assert.equal(items[0].kind, "separator");
  assert.equal(items[1].item, "Copy");
  assert.equal(items[2].text, "More");
  assert.equal(items[2].items.length, 1);
  assert.equal(items[2].items[0].text, "x");
});

test("showNativeMenu never hands Menu.new nested items carrying an action", () => {
  // tauri 2.12 drops the channel of an item built from nested options as soon
  // as Menu.new returns, so a click does nothing: items must be standalone.
  const source = readFileSync(new URL("./desktop-menu.ts", import.meta.url), "utf8");
  assert.match(source, /MenuItem\.new\(/);
  assert.doesNotMatch(source, /toTauriMenuItems/);
});

test("tidyMenuEntries drops leading, trailing and repeated separators", () => {
  const sep = { kind: "separator" };
  const out = tidyMenuEntries([sep, { label: "a" }, sep, sep, { label: "b" }, sep]);
  assert.deepEqual(out.map((e) => e.kind ?? e.label), ["a", "separator", "b"]);
});
