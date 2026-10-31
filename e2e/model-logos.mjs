import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";

const out = "test-results/model-logos";
await mkdir(out, { recursive: true });
await build({ entryPoints: ["e2e/model-logos.fixture.tsx"], bundle: true, platform: "browser", format: "iife",
  outfile: out + "/fixture.js", define: { "process.env.NODE_ENV": '"production"' }, jsx: "automatic", logLevel: "warning" });
const js = await readFile(out + "/fixture.js");
const sprite = await readFile("public/provider-icons.svg");
const css = (await Promise.all(["app/globals.css", "app/settings.css", "app/native-theme.css"].map(p => readFile(p, "utf8"))))
  .map(text => text.replace(/^@import[^;]*;/gm, "")).join("\n");
const server = createServer((req, res) => {
  const path = req.url?.split("?")[0];
  res.setHeader("Content-Type", path === "/fixture.js" ? "text/javascript" : path === "/style.css" ? "text/css" : path === "/provider-icons.svg" ? "image/svg+xml" : "text/html; charset=utf-8");
  res.end(path === "/fixture.js" ? js : path === "/style.css" ? css : path === "/provider-icons.svg" ? sprite :
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body style="margin:0"><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ headless: true, channel: process.env.E2E_BROWSER_CHANNEL || "chrome" });
try {
  for (const theme of ["light", "dark"]) for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [], external = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", route => {
      if (route.request().url().startsWith(base)) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    await page.goto(base);
    await page.evaluate(theme => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
    const trigger = page.getByRole("button", { name: "Model", exact: true });
    await trigger.click();
    const list = page.getByRole("listbox");
    await list.waitFor();
    for (const [name, symbol] of [["Claude Sonnet", "anthropic"], ["GPT 5.4", "openai"], ["Gemini 3 Pro", "google"], ["DeepSeek V4", "deepseek"], ["Qwen 3.5", "qwen"], ["Kimi K2.5", "kimi"], ["GLM 5", "zhipu"], ["MiniMax M2.5", "minimax"], ["Grok 4", "xai"]]) {
      const option = list.getByRole("option", { name, exact: true });
      assert.equal(await option.locator("use").getAttribute("href"), "/provider-icons.svg#" + symbol);
      assert.match(sprite.toString(), new RegExp('id="' + symbol + '"'));
      const icon = await option.locator("svg").evaluate(el => {
        const style = getComputedStyle(el);
        return { width: style.width, height: style.height, shrink: style.flexShrink };
      });
      assert.deepEqual(icon, { width: "16px", height: "16px", shrink: "0" });
    }
    const rect = await list.boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1, "menu fits viewport");
    await page.screenshot({ path: out + "/" + theme + "-" + width + ".png" });
    await list.getByRole("option", { name: "GPT 5.4", exact: true }).click();
    assert.equal(await trigger.locator("use").getAttribute("href"), "/provider-icons.svg#openai");
    await trigger.click();
    const filter = page.getByRole("textbox");
    await filter.fill("deepseek");
    assert.equal(await list.getByRole("option").count(), 1);
    await list.getByRole("option", { name: "DeepSeek V4", exact: true }).click();
    assert.equal(await trigger.locator("use").getAttribute("href"), "/provider-icons.svg#deepseek");
    await trigger.click();
    assert.equal(await list.getByRole("option", { name: "Custom model", exact: true }).locator('span[aria-hidden="true"]').innerText(), "MR");
    await page.keyboard.press("Escape");
    assert.equal(await list.count(), 0);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    await page.close();
    console.log("PASS model logos and selection: " + theme + " " + width);
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
