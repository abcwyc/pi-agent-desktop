import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { THEME_INIT_SCRIPT, THEME_OPTIONS, isDarkTheme, isThemePreference } from "./theme.ts";

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

// Execute the desktop's pre-page script too: it must not pin colorScheme to
// light when the user switches to Pine later, or overwrite newer browser prefs.
test("desktop bootstrap restores named palettes without overriding a stored preference", async () => {
  const { readFile } = await import("node:fs/promises");
  const rust = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const template = rust.match(/fn theme_bootstrap_script\(theme: &str\)[\s\S]*?r#"(.*?)"#/)[1];
  for (const saved of ["mist", "rose", "pine"]) {
    for (const stored of [null, "light", "pine", "auto"]) {
      const root = { dataset: {}, style: {}, classList: { toggle: (name, value) => { root[name] = value; } } };
      let preference = stored;
      runInNewContext(template.replaceAll("{theme}", saved).replaceAll("{{", "{").replaceAll("}}", "}"), {
        localStorage: { getItem: () => preference, setItem: (_, value) => { preference = value; } },
        window: { matchMedia: () => ({ matches: true }) },
        document: { documentElement: root },
      });
      const expected = stored === "auto" ? "dark" : stored ?? saved;
      assert.equal(preference, stored ?? saved);
      assert.equal(root.dataset.theme, expected);
      assert.equal(root.dark, isDarkTheme(expected));
      assert.equal(root.style.colorScheme, undefined, "CSS must own the color scheme after bootstrap");
    }
  }
});
