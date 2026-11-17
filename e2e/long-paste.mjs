import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";

const out = "test-results/long-paste";
await mkdir(out, { recursive: true });
await build({ entryPoints: ["e2e/long-paste.fixture.tsx"], bundle: true, platform: "browser", format: "iife", outfile: `${out}/fixture.js`, define: { "process.env.NODE_ENV": '"production"' }, jsx: "automatic", logLevel: "warning" });
const js = await readFile(`${out}/fixture.js`);
const css = (await Promise.all(["app/globals.css", "app/settings.css", "app/native-theme.css"].map((p) => readFile(p, "utf8")))).map((text) => text.replace(/^@import[^;]*;/gm, "")).join("\n");
const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/")) { res.setHeader("Content-Type", "application/json"); res.end("{}"); return; }
  res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/style.css" ? "text/css" : "text/html; charset=utf-8");
  res.end(req.url === "/fixture.js" ? js : req.url === "/style.css" ? css : '<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
try {
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const composer = page.locator("textarea").first();
  await composer.waitFor();
  const paste = async (text, html = "") => composer.evaluate((element, { text, html }) => {
    const data = new DataTransfer(); data.setData("text/plain", text);
    if (html) data.setData("text/html", html);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, { text, html });
  assert.equal(await paste("a".repeat(1999)), false);
  const text = "  日志\n\tconst x = 1;\n".repeat(150);
  await composer.fill("explain this");
  await composer.evaluate((element) => element.setSelectionRange(2, 5));
  assert.equal(await paste(text, "<p>ignored HTML</p>"), true);
  assert.equal(await composer.inputValue(), "explain this");
  assert.deepEqual(await composer.evaluate((element) => [element.selectionStart, element.selectionEnd]), [2, 5]);
  await page.getByRole("button", { name: "Pasted text.txt", exact: true }).click();
  assert.equal(await page.locator(".composer-file-preview").textContent(), text);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), theme);
    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.screenshot({ path: `${out}/${theme}-${width}.png`, fullPage: true });
    }
  }
  await paste("b".repeat(2000));
  assert.equal(await page.locator(".composer-file-chip").count(), 2);
  await page.getByRole("button", { name: "Switch draft", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".composer-file-chip").length === 0);
  await page.getByRole("button", { name: "Switch draft", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".composer-file-chip").length === 2);
  await composer.fill("");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#sent")?.textContent.includes("<attached_file"));
  assert.match(await page.locator("#sent").textContent(), /Pasted text-2.txt/);
  await page.getByRole("button", { name: "Restore submission", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".composer-file-chip").length === 2);
  await page.getByRole("button", { name: "Insert as text", exact: true }).first().click();
  assert.equal(await composer.inputValue(), text);
  await page.getByRole("button", { name: "Clear text and attachments", exact: true }).click();
  await paste("中".repeat(90000));
  assert.equal(await composer.inputValue(), "");
  assert.equal(await page.locator(".composer-file-chip").count(), 0);
  assert.match(await page.locator(".composer-paste-notice").textContent(), /larger than/);
  for (let index = 0; index < 5; index += 1) await paste("a".repeat(2000));
  await paste("sixth".repeat(500));
  assert.equal(await page.locator(".composer-file-chip").count(), 5);
  assert.match(await page.locator(".composer-paste-notice").textContent(), /at most 5/);
  assert.deepEqual(errors, []);
  console.log("PASS: long paste, preview, selection, draft restore, attachment-only send, insert as text, byte and count limits");
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
