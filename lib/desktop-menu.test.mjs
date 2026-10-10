import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { tidyMenuEntries, toPopupSpec } from "./desktop-menu-model.ts";

test("items become plain data with sequential ids and a handler per id", () => {
  let called = 0;
  const { items, actions } = toPopupSpec([
    { label: "Rename", onSelect: () => { called += 1; } },
    { label: "Disabled", disabled: true },
  ]);
  assert.deepEqual(items, [
    { kind: "item", id: "0", text: "Rename", enabled: true },
    { kind: "item", id: "1", text: "Disabled", enabled: false },
  ]);
  assert.equal(actions.size, 1, "an item without onSelect has no handler");
  actions.get("0")();
  assert.equal(called, 1);
});

test("checked maps to a check item, true or false", () => {
  const { items } = toPopupSpec([{ label: "b", checked: true }, { label: "c", checked: false }]);
  assert.equal(items[0].checked, true);
  assert.equal(items[1].checked, false);
});

test("separators, predefined items and submenus keep their shape; ids stay unique across submenus", () => {
  const picked = [];
  const { items, actions } = toPopupSpec([
    { kind: "separator" },
    { kind: "predefined", item: "Copy" },
    { kind: "predefined", item: "Paste", label: "Einfügen" },
    { kind: "submenu", label: "More", disabled: true, items: [{ label: "x", onSelect: () => picked.push("x") }] },
    { label: "after", onSelect: () => picked.push("after") },
  ]);
  assert.deepEqual(items[0], { kind: "separator" });
  assert.deepEqual(items[1], { kind: "predefined", item: "Copy" });
  assert.deepEqual(items[2], { kind: "predefined", item: "Paste", text: "Einfügen" });
  assert.equal(items[3].kind, "submenu");
  assert.equal(items[3].enabled, false);
  assert.equal(items[3].items[0].id, "0");
  assert.equal(items[4].id, "1");
  actions.get("0")();
  actions.get("1")();
  assert.deepEqual(picked, ["x", "after"]);
});

test("showNativeMenu hands the shell plain data and never builds JS menu resources", () => {
  // The JS menu API keeps resources and click channels on the page's side and
  // its popup holds the webview resource-table lock while the menu is open;
  // the menu is described as data and built in Rust (show_popup_menu).
  const source = readFileSync(new URL("./desktop-menu.ts", import.meta.url), "utf8");
  assert.match(source, /invoke<string \| null>\("show_popup_menu"/);
  assert.doesNotMatch(source, /@tauri-apps\/api\/menu/);
  assert.doesNotMatch(source, /await menu\.popup\(/);
  const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(rust, /async fn show_popup_menu/);
  assert.match(rust, /show_popup_menu,\n/);
  // The item boxes are dropped before the first await (they are not Send).
  const body = rust.slice(rust.indexOf("async fn show_popup_menu"));
  assert.ok(body.indexOf("let menu = {") !== -1 && body.indexOf("let menu = {") < body.indexOf(".await"));
});

test("native popups are on unless a build switches them off", () => {
  const source = readFileSync(new URL("./desktop-menu.ts", import.meta.url), "utf8");
  assert.match(source, /NEXT_PUBLIC_NATIVE_POPUP_MENUS !== "0"/);
});

test("tidyMenuEntries drops leading, trailing and repeated separators", () => {
  const sep = { kind: "separator" };
  const out = tidyMenuEntries([sep, { label: "a" }, sep, sep, { label: "b" }, sep]);
  assert.deepEqual(out.map((e) => e.kind ?? e.label), ["a", "separator", "b"]);
});
