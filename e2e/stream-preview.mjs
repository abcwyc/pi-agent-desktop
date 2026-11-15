// A page streamed into a message is drawn while it is written, then replaced
// by the normal preview, which runs it. Real components, real iframes.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";

const out = "test-results/stream-preview";
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["e2e/stream-preview.fixture.tsx"], bundle: true, platform: "browser", format: "iife",
  jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning", outfile: `${out}/current.js`,
});
const [js, ...styles] = await Promise.all([
  readFile(`${out}/current.js`),
  ...["app/globals.css", "app/settings.css", "app/native-theme.css", "node_modules/katex/dist/katex.min.css"].map((path) => readFile(path, "utf8")),
]);
const css = styles.map((text) => text.replace(/^@import[^;]*;/gm, "")).join("\n") + "\nbody{margin:0;font:14px/1.6 sans-serif;background:var(--bg);color:var(--text)}";
const server = createServer((req, res) => {
  if (req.url === "/current.js") { res.setHeader("Content-Type", "text/javascript"); res.end(js); }
  else if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css); }
  else { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/current.js"></script></body></html>'); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined), headless: true });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frameOf = async (locator) => (await locator.elementHandle()).contentFrame();

const head = '<!DOCTYPE html><html><head><style>body{font:14px sans-serif;padding:8px}.card{padding:8px;border:1px solid #888}</style></head><body><h1 id="title">Report</h1>';
// Long enough that a streamed snapshot passes the 256 characters the block remembers a page by.
const middle = '<div class="card" id="c1">First card of the report, with enough text to make this chunk a realistic size for a streamed page.</div><button id="go" onclick="window.CLICKED=1">go</button>';
const tail = '<div class="card" id="c2">Second card</div><p id="out">not run</p><script>document.addEventListener("DOMContentLoaded",function(){document.getElementById("out").textContent="ran after load"})</script></body></html>';
const artifact = (body, closed) => `Here it is.\n\n:::artifact{identifier="demo" type="html" title="Demo"}\n\`\`\`html\n${body}${closed ? "\n```\n:::\n" : ""}`;

const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  // Sandboxed frames have no storage: only the app page gets the setting.
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem("pi-locale", "en"); });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => window.previewFixture);
  const set = (text, streaming) => page.evaluate(({ text, streaming }) => window.previewFixture.set(text, streaming), { text, streaming });

  // 1. Streaming: a frame of its own draws the page as it arrives.
  await set(artifact(head, false), true);
  const streamFrame = page.locator('iframe[aria-busy="true"]');
  await streamFrame.waitFor({ timeout: 5000 });
  assert.equal(await streamFrame.getAttribute("sandbox").then((value) => /allow-same-origin/.test(value ?? "")), false);
  const inner = await frameOf(streamFrame);
  await inner.locator("#title").waitFor({ timeout: 5000 });
  await inner.evaluate(() => { document.getElementById("title").__kept = true; });

  await set(artifact(head + middle, false), true);
  await inner.locator("#c1").waitFor({ timeout: 5000 });
  assert.equal(await inner.evaluate(() => document.getElementById("title").__kept === true), true, "what is drawn is patched in place");
  assert.equal(await inner.evaluate(() => !document.getElementById("go").hasAttribute("onclick")), true, "handlers are stripped");
  await inner.locator("#go").click();
  assert.equal(await inner.evaluate(() => "CLICKED" in window), false, "the streamed page does not run");
  assert.equal(await page.locator("iframe").count(), 1, "one frame while it streams");
  results.push("streams in place");

  // The user can still read the source while it streams.
  const toggle = page.locator(".markdown-code-action", { hasText: /^(Source|Preview)$/ });
  assert.equal(await toggle.isDisabled(), false);
  await toggle.click();
  assert.equal(await page.locator("iframe").count(), 0, "source view while streaming");
  await toggle.click();
  await page.locator('iframe[aria-busy="true"]').waitFor({ timeout: 5000 });
  results.push("source toggle while streaming");

  // 2. Finished: the normal preview replaces it and runs the page as written.
  await set(artifact(head + middle + tail, true), false);
  await page.locator("iframe:not([aria-busy])").waitFor({ timeout: 5000 });
  assert.equal(await page.locator('iframe[aria-busy="true"]').count(), 0);
  const final = await frameOf(page.locator("iframe:not([aria-busy])"));
  await final.locator("#c2").waitFor({ timeout: 5000 });
  assert.equal(await final.locator("#out").textContent(), "ran after load", "scripts and DOMContentLoaded work in the final frame");
  results.push("final frame runs the page");

  // 3. A page that needs an external stylesheet is not streamed as a bare page.
  await set(artifact('<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body><div class="p-4">x</div>', false), true);
  await delay(300);
  assert.equal(await page.locator("iframe").count(), 0, "Tailwind CDN pages stay source while streaming");
  results.push("external styles stay source");

  assert.deepEqual(errors, []);
  console.log(`stream preview e2e: ${results.join("; ")}`);
} finally {
  await browser.close();
  server.close();
}
