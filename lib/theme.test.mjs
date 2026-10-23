import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { THEME_INIT_SCRIPT, THEME_OPTIONS, isDarkTheme, isThemePreference } from "./theme.ts";
import { BACKGROUND_OPTIONS, DEFAULT_BACKGROUND } from "./backgrounds.ts";

test("first paint restores every palette and falls back to the system for invalid or blocked storage", () => {
  for (const systemDark of [false, true]) {
    for (const stored of [...THEME_OPTIONS.map(({ id }) => id), null, "", "unknown", new Error("Blocked")]) {
      const root = { dataset: {}, classList: { toggle: (name, value) => { root[name] = value; } } };
      runInNewContext(THEME_INIT_SCRIPT, {
        localStorage: { getItem: () => { if (stored instanceof Error) throw stored; return stored; } },
        window: { matchMedia: () => ({ matches: systemDark }) },
        document: { documentElement: root },
      });
      const expected = isThemePreference(stored) && stored !== "auto" ? stored : systemDark ? "dark" : "light";
      assert.equal(root.dataset.theme, expected);
      assert.equal(root.dark, isDarkTheme(expected));
    }
  }
});

test("first paint restores background independently of light/dark appearance", () => {
  for (const background of [...BACKGROUND_OPTIONS.map(({ id }) => id), "unknown", null]) {
    const root = { dataset: {}, classList: { toggle() {} } };
    runInNewContext(THEME_INIT_SCRIPT, {
      localStorage: { getItem: (key) => key === "pi-background" ? background : "dark" },
      window: { matchMedia: () => ({ matches: false }) },
      document: { documentElement: root },
    });
    assert.equal(root.dataset.theme, "dark");
    assert.equal(root.dataset.background, background && background !== "unknown" ? background : DEFAULT_BACKGROUND);
  }
});
