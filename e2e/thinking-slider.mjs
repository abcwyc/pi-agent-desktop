import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";

const out = "test-results/thinking-slider";
await mkdir(out, { recursive: true });
await build({ entryPoints: ["e2e/thinking-slider.fixture.tsx"], bundle: true, platform: "browser", format: "iife",
  outfile: out + "/fixture.js", define: { "process.env.NODE_ENV": '"production"' }, jsx: "automatic", logLevel: "warning" });
const js = await readFile(out + "/fixture.js");
const css = (await Promise.all(["app/globals.css", "app/settings.css", "app/native-theme.css"].map(p => readFile(p, "utf8"))))
  .map(text => text.replace(/^@import[^;]*;/gm, "")).join("\n");
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/style.css" ? "text/css" : "text/html; charset=utf-8");
  res.end(req.url === "/fixture.js" ? js : req.url === "/style.css" ? css :
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body style="margin:0"><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, channel: process.env.E2E_BROWSER_CHANNEL || "chrome" });
try {
  for (const theme of ["light", "dark"]) for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 720 }, reducedMotion: "reduce" });
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.evaluate(theme => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
    const slider = page.getByRole("slider"), output = page.locator("output");
    await slider.waitFor();
    assert.equal(await output.innerText(), "medium");
    const box = await slider.boundingBox();
    const start = box.x + 9 + (box.width - 18) * 4 / 7;
    await page.mouse.move(start, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 9 + (box.width - 18) * .8, box.y + box.height / 2, { steps: 12 });
    assert.equal(await output.getAttribute("data-commits"), "0", "drag does not send intermediate requests");
    const preview = Number(await slider.inputValue());
    assert.ok(Math.abs(preview - Math.round(preview)) > .05, "thumb travels between stops");
    await page.mouse.move(box.x + box.width - 9, box.y + box.height / 2);
    await page.mouse.up();
    assert.equal(await output.innerText(), "max");
    assert.equal(await output.getAttribute("data-commits"), "1");
    await page.screenshot({ path: `${out}/${theme}-${width}-max.png` });
    await slider.press("Home"); assert.equal(await output.innerText(), "auto");
    await slider.press("ArrowRight"); assert.equal(await output.innerText(), "off");
    await slider.press("End"); assert.equal(await output.innerText(), "max");
    await slider.press("ArrowLeft"); assert.equal(await output.innerText(), "xhigh");
    await page.getByRole("button", { name: "Restricted" }).click();
    assert.equal(await slider.getAttribute("max"), "2");
    await slider.press("ArrowRight"); assert.equal(await output.innerText(), "high");
    await slider.press("ArrowLeft"); assert.equal(await output.innerText(), "low");
    const nextBox = await slider.boundingBox();
    await page.mouse.move(nextBox.x + nextBox.width / 2, nextBox.y + nextBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(nextBox.x + nextBox.width - 9, nextBox.y + nextBox.height / 2);
    const count = await output.getAttribute("data-commits");
    await slider.dispatchEvent("pointercancel");
    await page.mouse.up();
    assert.equal(await output.getAttribute("data-commits"), count, "cancel does not commit");
    await page.screenshot({ path: `${out}/${theme}-${width}.png` });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS continuous preview, release, keyboard, supported levels, cancel: ${theme} ${width}`);
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
