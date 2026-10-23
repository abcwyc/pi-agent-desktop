import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const out = "test-results/fonts";
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["e2e/appearance.fixture.jsx"], bundle: true, platform: "browser", format: "iife",
  outfile: `${out}/fixture.js`, define: { "process.env": '{"NODE_ENV":"production"}' }, jsx: "automatic", logLevel: "warning",
  plugins: [{ name: "desktop-button-layout", setup(bundler) {
    // Exercise installed-font UI through the real native fetch boundary, with
    // the capability handshake replaced only in this browser fixture.
    bundler.onLoad({ filter: /components[/\\]FontSettings\.tsx$/ }, async ({ path }) => ({
      loader: "tsx", contents: (await readFile(path, "utf8")).replace('if (!isTauriDesktop()) return;', ''),
    }));
    bundler.onLoad({ filter: /lib[/\\]desktop-native\.ts$/ }, async ({ path }) => ({
      loader: "ts", contents: (await readFile(path, "utf8"))
        .replace('if (!isTauriDesktop()) throw new Error("Installed fonts are only available in the desktop app.");', '')
        .replace('headers: await desktopApiHeaders(), cache: "no-store"', 'cache: "no-store"'),
    }));
    bundler.onLoad({ filter: /components[/\\]AppearanceSettings\.tsx$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      assert.ok(source.includes("{isTauriDesktop() &&"));
      // Render the real desktop-only button, without invoking native APIs.
      return { loader: "tsx", contents: source.replace("{isTauriDesktop() &&", "{true &&") };
    });
  } }],
});
const js = await readFile(`${out}/fixture.js`);
const css = (await Promise.all(["app/globals.css", "app/settings.css", "app/native-theme.css"].map((p) => readFile(p, "utf8"))))
  .map((s) => s.replace(/^@import[^;]*;/gm, "")).join("\n");
let stored = null, activeWrites = 0, maxWrites = 0, failWrites = false, failFontList = false, fontReads = 0;
const installed = ['Microsoft YaHei','Consolas','Segoe UI','JetBrains Mono','User Installed UI',
  ...Array.from({length:220},(_,i)=>`Installed Family ${String(i).padStart(3,'0')}`)]
  .map(family=>({family,names:family==='Microsoft YaHei'?[{lang:'zh-cn',name:'微软雅黑'}]:[]}));
const serve = async (req, res) => {
  if(req.url === '/api/desktop/fonts') {
    fontReads++; res.setHeader('Content-Type','application/json');
    res.statusCode=failFontList?503:200;
    res.end(JSON.stringify(failFontList?{error:'test enumeration failure'}:{fonts:installed}));return;
  }
  if (req.url === "/api/appearance/fonts") {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "PUT") {
      let body = ""; for await (const chunk of req) body += chunk;
      activeWrites++; maxWrites = Math.max(maxWrites, activeWrites);
      await delay(80); activeWrites--;
      if (failWrites) { res.statusCode = 500; res.end(JSON.stringify({ error: "test save failure" })); return; }
      stored = JSON.parse(body).fonts;
    }
    res.end(JSON.stringify({ fonts: stored })); return;
  }
  if (req.url.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/api/appearance" ? { background: "mist" } : {})); return;
  }
  res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/style.css" ? "text/css" : "text/html; charset=utf-8");
  res.end(req.url === "/fixture.js" ? js : req.url === "/style.css" ? css + '\n:root{--font-ui:"Arial",sans-serif;--font-mono:"Courier New",monospace}' :
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}*,*::before,*::after{transition:none!important}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
};
const servers = [createServer(serve), createServer(serve)];
for (const server of servers) await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const urls = servers.map((s) => `http://127.0.0.1:${s.address().port}`);
const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined), headless: true });
const results = [];
async function open({ width = 1280, theme = "light", locale = "en", url = urls[0] } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 960 }, colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(({ theme, locale }) => { localStorage.setItem("pi-theme", theme); localStorage.setItem("pi-locale", locale); }, { theme, locale });
  await page.goto(url);
  await page.locator(".settings-font-section").waitFor();
  return page;
}
const choose = async (page, label, name) => {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
};
const expectFont = (page, kind, name) => page.waitForFunction(({ kind, name }) =>
  document.documentElement.style.getPropertyValue(`--font-${kind}`).startsWith(`"${name}",`), { kind, name });
async function settled(page) {
  await page.waitForFunction(() => !document.querySelector(".settings-font-status[role=status]"));
}
try {
  const page = await open();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  assert.equal(await page.getByRole('button',{name:'Reset fonts',exact:true}).count(),0,'default fonts must not show an unusable reset control');
  // A newly installed family outside the old presets must be directly selectable.
  await choose(page,'Interface font','User Installed UI'); await expectFont(page,'ui','User Installed UI'); await settled(page);
  await page.getByRole('combobox',{name:'Interface font',exact:true}).click();
  assert.equal(await page.getByRole('option').count(),installed.length+2,'the complete installed collection must be selectable');
  const bounds=await page.locator('.app-select-menu').boundingBox();
  assert.ok(bounds.y>=0&&bounds.y+bounds.height<=960&&bounds.height<=361,'a long font list must stay inside the window');
  await page.keyboard.press('Escape');
  const reads=fontReads;
  assert.equal(await page.getByRole('textbox',{name:'Interface font name',exact:true}).count(),0);
  await choose(page, "Interface font", "Microsoft YaHei"); await expectFont(page, "ui", "Microsoft YaHei");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Interface font");
  await choose(page, "Code font", "Consolas"); await expectFont(page, "mono", "Consolas"); await settled(page);
  assert.deepEqual(stored, { ui: "Microsoft YaHei", mono: "Consolas" });
  assert.equal(fontReads,reads,'changing a font must not re-enumerate the system');
  assert.equal(maxWrites, 1, "quick choices save in order");
  assert.ok((await page.locator(".settings-font-preview p").evaluate((el) => getComputedStyle(el).fontFamily)).includes("Microsoft YaHei"));
  assert.ok((await page.locator(".settings-font-preview code").evaluate((el) => getComputedStyle(el).fontFamily)).includes("Consolas"));
  await page.reload(); await expectFont(page, "ui", "Microsoft YaHei");
  await page.goto(urls[1]); await expectFont(page, "ui", "Microsoft YaHei"); await expectFont(page, "mono", "Consolas");

  await choose(page, "Interface font", "Custom font…");
  const custom = page.getByRole("textbox", { name: "Interface font name", exact: true });
  await custom.fill("Arial; color:red");
  assert.equal(await page.getByRole("button", { name: "Apply", exact: true }).isEnabled(), false);
  await custom.fill("宋体"); await custom.press("Enter"); await expectFont(page, "ui", "宋体"); await settled(page);
  assert.equal(stored.ui, "宋体");
  await page.getByRole("button", { name: "Reset fonts", exact: true }).click(); await settled(page);
  assert.deepEqual(stored, { ui: "", mono: "" });
  assert.equal(await page.getByRole('button',{name:'Reset fonts',exact:true}).count(),0);
  assert.equal(await page.locator("html").evaluate((el) => el.style.getPropertyValue("--font-ui")), "");
  assert.ok((await page.locator(".settings-font-preview p").evaluate((el) => getComputedStyle(el).fontFamily)).startsWith("Arial"), "reset restores custom.css");

  // A delayed restore cannot undo a user's newer choice.
  let release, markBlocked;
  const held = new Promise((r) => { release = r; }), blocked = new Promise((r) => { markBlocked = r; });
  await page.route("**/api/appearance/fonts", async (route) => {
    if (route.request().method() === "GET") { markBlocked(); await held; await route.fulfill({ json: { fonts: { ui: "Arial", mono: "Menlo" } } }); }
    else await route.continue();
  });
  await page.reload(); await blocked;
  await choose(page, "Interface font", "Segoe UI"); release(); await settled(page); await expectFont(page, "ui", "Segoe UI");
  await page.unroute("**/api/appearance/fonts");
  failWrites = true;
  await choose(page, "Code font", "JetBrains Mono");
  await page.locator(".settings-font-status[role=alert]").waitFor(); await expectFont(page, "mono", "JetBrains Mono");
  failWrites = false; await page.getByRole("button", { name: "Retry", exact: true }).click(); await settled(page);
  assert.equal(stored.mono, "JetBrains Mono");
  await page.route("**/api/appearance/fonts", (route) => route.fulfill({ status: 500, json: { error: "test read failure" } }));
  await page.reload(); await page.locator(".settings-font-status[role=alert]").waitFor();
  await page.unroute("**/api/appearance/fonts");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.locator(".settings-font-status[role=alert]").waitFor({ state: "hidden" });
  await expectFont(page, "mono", "JetBrains Mono");
  assert.deepEqual(errors, []);
  // Enumeration failure keeps manual entry available and offers a working retry.
  failFontList=true; await page.reload();
  await page.getByText('Could not read installed fonts. Retry or enter a font name manually.',{exact:true}).waitFor();
  await choose(page,'Interface font','Custom font…');
  await page.getByRole('textbox',{name:'Interface font name',exact:true}).fill('User Installed UI');
  await page.getByRole('button',{name:'Apply',exact:true}).click(); await settled(page);
  failFontList=false; await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.getByText('Could not read installed fonts. Retry or enter a font name manually.',{exact:true}).waitFor({state:'hidden'});
  await page.getByRole('combobox',{name:'Interface font',exact:true}).click();
  assert.equal(await page.getByRole('option',{name:'User Installed UI',exact:true}).count(),1);
  await page.keyboard.press('Escape');
  await page.close();

  for (const theme of ["light", "dark"]) for (const width of [1464, 1280, 390, 320]) {
    const page = await open({ theme, width, locale: "zh-CN" });
    await page.getByRole('combobox',{name:'界面字体',exact:true}).click();
    await page.getByRole('option',{name:'微软雅黑 (Microsoft YaHei)',exact:true}).waitFor();
    assert.equal(await page.getByRole('option',{name:'PingFang SC',exact:true}).count(),0,'uninstalled presets must not appear as installed fonts');
    await page.keyboard.press('Escape');
    const button = page.getByRole("button", { name: "打开 custom.css", exact: true });
    await button.scrollIntoViewIfNeeded();
    const geometry = await button.evaluate((button) => {
      const row = button.closest(".settings-option"), a = row.getBoundingClientRect(), b = button.getBoundingClientRect();
      return { delta: (b.top + b.bottom - a.top - a.bottom) / 2, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.ok(Math.abs(geometry.delta) < 0.6, `custom.css button must be centered: ${JSON.stringify({ width, theme, ...geometry })}`);
    assert.equal(geometry.overflow, false);
    const fontSection = page.locator(".settings-font-section"); await fontSection.scrollIntoViewIfNeeded();
    await page.getByRole("combobox", { name: "代码字体", exact: true }).click();
    const menu = page.locator(".app-select-menu");
    const spacing = await menu.evaluate((el) => {
      const bounds = el.getBoundingClientRect(), rows = [...el.querySelectorAll('[role="option"]')].map((r) => r.getBoundingClientRect());
      return { inset: rows[0].left - bounds.left, gap: rows[1].top - rows[0].bottom };
    });
    assert.ok(spacing.inset >= 7 && spacing.inset <= 9, JSON.stringify(spacing));
    assert.ok(Math.abs(spacing.gap - 4) < 0.6, JSON.stringify(spacing));
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `${out}/${theme}-${width}.png` });
    results.push({ theme, width, ...geometry, ...spacing }); await page.close();
  }
  await writeFile(`${out}/results.json`, JSON.stringify({ results, orderedSaves: maxWrites, persistence: true, newOrigin: true, staleRead: true, retry: true, customCssReset: true }, null, 2));
  console.log("PASS: 225 installed families, localized names, missing presets excluded, list retry/manual fallback, conditional reset, preview, persistence, ordered saves, menu spacing and centered custom.css button");
} finally {
  await browser.close();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
}
