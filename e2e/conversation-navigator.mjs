import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";

const out = "test-results/conversation-navigator";
await mkdir(out, { recursive: true });
await build({ entryPoints: ["e2e/conversation-navigator.fixture.tsx"], bundle: true, platform: "browser", format: "iife",
  outfile: `${out}/fixture.js`, define: { "process.env.NODE_ENV": '"production"' }, jsx: "automatic", logLevel: "warning" });
const js = await readFile(`${out}/fixture.js`);
const css = (await Promise.all(["app/globals.css", "app/settings.css", "app/native-theme.css"].map((p) => readFile(p, "utf8"))))
  .map((text) => text.replace(/^@import[^;]*;/gm, "")).join("\n")
  + "\n*{box-sizing:border-box}body{margin:0}h3{margin:0 0 12px}p{line-height:1.6}button{font:inherit}";
const server = createServer((req, res) => {
  const path = req.url?.split("?")[0];
  res.setHeader("Content-Type", path === "/fixture.js" ? "text/javascript" : path === "/style.css" ? "text/css" : "text/html; charset=utf-8");
  res.end(path === "/fixture.js" ? js : path === "/style.css" ? css :
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined, headless: true });
const results = [];
try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: theme, reducedMotion: "reduce" });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((theme) => {
      document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.toggle("dark", theme === "dark"));
      localStorage.setItem("pi-locale", "en");
    }, theme);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator("article").first().waitFor();
    const navigator = page.getByRole("slider", { name: "Conversation navigation" });
    const visible = async () => {
      await navigator.waitFor({ state: "visible" });
      const geometry = await navigator.evaluate((track) => {
        const scroll = document.querySelector(".chat-scroll-container"), text = document.querySelector("article");
        return { right: track.getBoundingClientRect().right, textLeft: text.getBoundingClientRect().left, chatWidth: scroll.getBoundingClientRect().width };
      });
      assert.ok(geometry.chatWidth >= 1024, JSON.stringify(geometry));
      assert.ok(geometry.textLeft - geometry.right >= 16, "the entire navigator hit target must clear the text: " + JSON.stringify(geometry));
      return geometry;
    };
    const hidden = () => navigator.waitFor({ state: "detached" });
    const change = (values) => page.evaluate((values) => {
      for (const [name, value] of Object.entries(values)) window.navigatorFixture[name](value);
    }, values);
    await visible();
    await page.getByRole("button", { name: "Toggle workspace" }).click(); await hidden();
    await page.getByRole("button", { name: "Toggle workspace" }).click(); await visible();
    // A large overall window must not keep the navigator on a narrowed chat pane.
    await change({ setSidebarWidth: 440 }); await hidden();
    await change({ setSidebarWidth: 240 }); await visible();
    // User-controlled body widths can consume the gutter even on a wide screen.
    await change({ setTextWidth: 1200 }); await hidden();
    await change({ setTextWidth: 820, setFontSize: 24 }); await visible();
    await change({ setFontSize: 12 }); await visible();
    await change({ setSidebarWidth: 0 });
    await page.setViewportSize({ width: 1023, height: 900 }); await hidden();
    await page.setViewportSize({ width: 1024, height: 900 }); await visible();
    await page.setViewportSize({ width: 1920, height: 900 });
    await change({ setSidebarWidth: 240, setFontSize: 14 }); await visible();
    await navigator.focus(); await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => document.documentElement.dataset.selectedTurn === "1");
    const scrollBefore = await page.locator(".chat-scroll-container").evaluate((el) => el.scrollTop);
    await change({ setRightOpen: true }); await hidden();
    assert.ok(await page.locator(".chat-scroll-container").evaluate((el) => el.clientWidth) > 1024,
      "even an otherwise roomy chat pane must hide the navigator with the workspace open");
    assert.equal(await page.locator(".conversation-navigator-preview").count(), 0);
    await change({ setRightOpen: false }); await visible();
    assert.equal(await page.locator(".chat-scroll-container").evaluate((el) => el.scrollTop), scrollBefore,
      "hiding/restoring the navigator must not scroll the conversation");
    assert.equal(await page.locator(".conversation-navigator-preview").count(), 0, "old hover/keyboard previews must not reappear");
    const box = await navigator.boundingBox();
    await page.mouse.move(box.x + 5, box.y + 5); await page.locator(".conversation-navigator-preview").waitFor();
    await page.locator(".conversation-navigator-preview").click();
    await page.screenshot({ path: `${out}/${theme}-wide.png` });
    await change({ setTextWidth: 2000 }); await hidden();
    await page.setViewportSize({ width: 2560, height: 900 }); await visible();
    for (const width of [960, 640, 390, 320]) {
      await page.setViewportSize({ width, height: 900 }); await change({ setSidebarWidth: 0, setTextWidth: 820 }); await hidden();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.screenshot({ path: `${out}/${theme}-narrow.png` });
    assert.deepEqual(errors, []);
    results.push({ theme, paneOpenHides: true, gutterMeasured: true, widthPreference: true, keyboardAndClick: true, scrollStable: true });
    await page.close();
  }
  await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
  console.log("PASS: real navigator, light/dark, 320–2560px, workspace/sidebar changes, 820–2000px text widths, clear gutter, keyboard/click navigation and stable scroll");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
