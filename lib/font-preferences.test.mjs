import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { DEFAULT_FONTS, FONT_INIT_SCRIPT, isFontFamily, isFontPreferences } from "./font-preferences.ts";

test("font choices accept installed family names, including CJK, and reject CSS syntax", () => {
  for (const name of ["", "Segoe UI", "思源黑体 CN", "Sarasa Mono SC", "M+ 1m"]) assert.equal(isFontFamily(name), true);
  for (const name of [null, 12, " leading", "x\n", "x; color:red", '"x"', "x, serif", "url(font)", "var(--x)", "</style>", "x".repeat(121)]) assert.equal(isFontFamily(name), false);
  assert.equal(isFontPreferences(DEFAULT_FONTS), true);
  for (const value of [null, [], {}, { ui: "Arial" }, { ui: "Arial", mono: false }]) assert.equal(isFontPreferences(value), false);
});

test("first paint restores fonts safely, while defaults leave the custom stylesheet in charge", () => {
  for (const stored of [JSON.stringify({ ui: "Microsoft YaHei", mono: "Consolas" }), JSON.stringify(DEFAULT_FONTS), "{", null, JSON.stringify({ ui: "x; color:red", mono: "" }), new Error("blocked")]) {
    const properties = new Map();
    runInNewContext(FONT_INIT_SCRIPT, {
      localStorage: { getItem() { if (stored instanceof Error) throw stored; return stored; } },
      document: { documentElement: { style: {
        setProperty: (key, value) => properties.set(key, value),
        removeProperty: (key) => properties.delete(key),
      } } },
    });
    if (typeof stored === "string" && stored.includes("Consolas")) {
      assert.equal(properties.get("--font-ui"), '"Microsoft YaHei", var(--font-ui-default)');
      assert.equal(properties.get("--font-display"), '"Microsoft YaHei", var(--font-display-default)');
      assert.equal(properties.get("--font-mono"), '"Consolas", var(--font-mono-default)');
    } else assert.equal(properties.size, 0);
  }
});
