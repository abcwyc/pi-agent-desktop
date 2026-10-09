// Run against an existing dev server: node e2e/themes.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30141";
const artifacts = fileURLToPath(new URL("../test-results/themes/", import.meta.url));
const themes = ["light", "dark", "mist", "rose", "pine", "auto"];
const labels = ["Light", "Dark", "Mist", "Rose", "Pine", "System"];
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch();

// The fork's surfaces are translucent (rgba / transparent over the window
// vibrancy), so resolve every token to opaque RGB by compositing it over the
// page background before measuring contrast.
function parseColor(value) {
  const text = value.trim();
  if (text === "transparent") return [0, 0, 0, 0];
  if (text.startsWith("#")) {
    const digits = text.length === 4 ? [...text.slice(1)].map((digit) => digit + digit).join("") : text.slice(1);
    return [...digits.match(/../g).map((part) => parseInt(part, 16)), 1];
  }
  const match = text.match(/^rgba?\(([^)]+)\)$/);
  assert.ok(match, `Unsupported color token: ${value}`);
  const [r, g, b, a = 1] = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return [r, g, b, a];
}

function composite(color, base) {
  const [r, g, b, a] = color;
  return [0, 1, 2].map((i) => [r, g, b][i] * a + base[i] * (1 - a));
}

function contrast(a, b, baseToken) {
  const base = composite(parseColor(baseToken), [255, 255, 255]);
  const resolve = (token) => composite(parseColor(token), base);
  const luminance = (rgb) => {
    const channels = rgb.map((part) => {
      const value = part / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const backgroundRgb = resolve(b);
  const foreground = parseColor(a);
  const foregroundRgb = composite(foreground, backgroundRgb);
  const values = [luminance(foregroundRgb), luminance(backgroundRgb)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US", colorScheme: "light", reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Keep the check independent of the user's session catalogue.
    await page.route(/\/api\/sessions(?:\?.*)?$/, (route) => route.fulfill({ json: { sessions: [] } }));
    await page.goto(base);
    await page.getByText("No projects found", { exact: true }).waitFor({ state: "attached" });
    const openSettings = async () => {
      const sidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
      if (width <= 640) await sidebar.waitFor();
      if (await sidebar.isVisible()) {
        await sidebar.click();
        // The mobile sidebar slides in; the Settings menu anchors to the button's
        // position at click time, so wait until the drawer has stopped moving.
        await page.waitForFunction(() => {
          const left = document.querySelector(".session-sidebar")?.getBoundingClientRect().left;
          return left !== undefined && left >= 0;
        });
        await page.waitForTimeout(300);
      }
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      // The fork's Settings button opens a section menu; the themes live in General.
      await page.getByRole("menuitem", { name: "General", exact: true }).click();
    };
    const expectTheme = async (theme) => {
      await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
      assert.equal(await page.locator("html").evaluate((root) => root.classList.contains("dark")), theme === "dark" || theme === "pine");
      assert.equal(await page.locator("html").evaluate((root) => getComputedStyle(root).colorScheme), theme === "dark" || theme === "pine" ? "dark" : "light");
    };
    await openSettings();
    for (const [index, theme] of themes.entries()) {
      const radio = page.getByRole("radio", { name: labels[index], exact: true });
      await radio.locator("..").click();
      await expectTheme(theme === "auto" ? "light" : theme);
      assert.equal(await radio.isChecked(), true);
      assert.equal(await page.evaluate(() => localStorage.getItem("pi-theme")), theme);
      const colors = await page.locator("html").evaluate((root) => {
        const style = getComputedStyle(root);
        return Object.fromEntries(["bg", "bg-panel", "bg-hover", "bg-selected", "user-bg", "assistant-bg", "tool-bg", "text", "text-muted", "text-dim", "accent", "accent-hover", "accent-contrast"].map((key) => [key, style.getPropertyValue(`--${key}`).trim()]));
      });
      for (const foreground of ["text", "text-muted", "text-dim", "accent"]) {
        for (const background of ["bg", "bg-panel", "bg-hover", "bg-selected", "user-bg", "assistant-bg", "tool-bg"]) {
          // docs/native-theme.md: text-dim is the one token held to a 3:1 floor (timestamps,
          // tags); everything else is body text and must meet the 4.5:1 AA ratio.
          const floor = foreground === "text-dim" ? 3 : 4.5;
          assert.ok(contrast(colors[foreground], colors[background], colors.bg) >= floor, `${theme}: ${foreground} on ${background} must reach ${floor}:1`);
        }
      }
      for (const background of ["accent", "accent-hover"]) {
        assert.ok(contrast(colors["accent-contrast"], colors[background], colors.bg) >= 4.5, `${theme}: button contrast`);
      }
      assert.equal(await page.locator(".settings-theme-option").evaluateAll((options) => options.every((option) => {
        const label = option.querySelector(".settings-theme-option-label");
        const box = option.getBoundingClientRect();
        const text = label.getBoundingClientRect();
        return option.scrollWidth <= option.clientWidth && text.right <= box.right && text.bottom <= box.bottom;
      })), true, `Theme labels must fit at ${width}px`);
      await page.screenshot({ path: `${artifacts}/${theme}-${width}.png`, animations: "disabled" });
      await page.reload();
      await expectTheme(theme === "auto" ? "light" : theme);
      await openSettings();
      assert.equal(await radio.isChecked(), true, "Selection must survive refresh");
    }
    await page.emulateMedia({ colorScheme: "dark" });
    await expectTheme("dark");
    await page.getByRole("radio", { name: "Pine", exact: true }).locator("..").click();
    await page.emulateMedia({ colorScheme: "light" });
    await expectTheme("pine");
    const light = page.getByRole("radio", { name: "Light", exact: true });
    await light.focus();
    await light.press("ArrowRight");
    await expectTheme("dark");
    assert.equal(await page.getByRole("radio", { name: "Dark", exact: true }).isChecked(), true);
    await page.keyboard.press("Escape");
    await page.reload();
    await expectTheme("dark");
    // The fork has no topbar theme/language menus (declined upstream UI); the
    // Settings radios above are the only theme control.
    if (width === 1440) {
      await openSettings();
      await page.getByRole("radio", { name: "Dark", exact: true }).locator("..").click();
      await expectTheme("dark");
      await page.reload();
      await expectTheme("dark");
      for (const key of ["bg", "bg-panel", "bg-hover", "bg-selected", "border", "text", "text-muted", "text-dim", "user-bg", "tool-bg"]) {
        const hex = await page.locator("html").evaluate((root, token) => getComputedStyle(root).getPropertyValue(`--${token}`).trim(), key);
        // The fork's dark palette follows Apple's system grays (#1c1c1e is faintly
        // cool), so require "no visible tint" rather than exactly equal channels.
        // Translucent tokens (rgba) are overlays, not surfaces; skip them.
        if (!hex.startsWith("#")) continue;
        const channels = (hex.length === 4 ? hex.slice(1).match(/./g).map((c) => c + c) : hex.slice(1).match(/../g)).map((c) => parseInt(c, 16));
        assert.ok(Math.max(...channels) - Math.min(...channels) <= 4, `Dark ${key} (${hex}) must stay near neutral gray`);
      }
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: palettes, contrast, persistence, system preference, keyboard navigation`);
    await context.close();
  }
} finally {
  await browser.close();
}
