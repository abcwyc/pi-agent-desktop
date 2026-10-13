// Standalone browser checks for the bundled manager and injected logo bridge.
// Native persistence and migration are covered by src-tauri's Rust tests.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 560, height: 580 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("http://manager.test/**", async route => {
    const js = route.request().url().endsWith(".js");
    await route.fulfill({ contentType: js ? "text/javascript" : "text/html", body: await readFile(new URL(`../public/desktop-backend.${js ? "js" : "html"}`, import.meta.url), "utf8") });
  });
  await page.addInitScript(() => {
    window.calls = [];
    window.config = { active: "", remotes: [{ name: "Office", url: "https://office.example/" }] };
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      window.calls.push([command, args]);
      if (window.fail) throw "Cannot save settings";
      if (command === "save_backend") {
        const url = new URL(args.url).href;
        const old = window.config.remotes.find(remote => remote.url === url);
        if (old) old.name = args.name;
        else window.config.remotes.push({ name: args.name, url });
      }
      if (command === "remove_backend") window.config.remotes = window.config.remotes.filter(remote => remote.url !== args.url);
      if (command === "activate_backend") window.config.active = args.url;
      return structuredClone(window.config);
    } };
  });
  await page.goto("http://manager.test/desktop-backend.html");
  await page.getByText("Office", { exact: true }).waitFor();
  await page.locator("#name").fill("Home");
  await page.locator("#url").fill("https://home.example");
  await page.getByRole("button", { name: "保存远端" }).click();
  await page.getByText("Home", { exact: true }).waitFor();
  await page.locator(".server").filter({ hasText: "Office" }).getByRole("button", { name: "编辑" }).click();
  await page.locator("#name").fill("Office renamed");
  await page.getByRole("button", { name: "保存远端" }).click();
  await page.getByText("Office renamed", { exact: true }).waitFor();
  assert.equal(await page.locator(".server").count(), 3);
  await page.locator(".server").filter({ hasText: "Home" }).getByRole("button", { name: "移除" }).click();
  await page.getByText("Home", { exact: true }).waitFor({ state: "detached" });
  await page.evaluate(() => { window.fail = true; });
  await page.locator("#name").fill("Fail"); await page.locator("#url").fill("https://fail.example");
  await page.getByRole("button", { name: "保存远端" }).click();
  await page.getByRole("alert").filter({ hasText: "Cannot save settings" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "保存远端" }).isEnabled(), true);
  await page.evaluate(() => { window.fail = false; });
  await page.locator(".server").filter({ hasText: "Office renamed" }).getByRole("button", { name: "连接", exact: true }).click();
  await page.getByText("正在重启…", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.config.active), "https://office.example/");
  assert.deepEqual(errors, []);

  const logo = await browser.newPage();
  let requests = 0;
  await logo.route("https://pi-desktop.invalid/**", route => { requests++; return route.abort(); });
  await logo.route("https://remote.test/**", route => route.fulfill({ contentType: "text/html", body: '<a class="brand" href="/"><span>Remote logo</span></a>' }));
  await logo.addInitScript({ path: new URL("../desktop/backend-logo.js", import.meta.url).pathname });
  await logo.goto("https://remote.test/");
  const button = logo.getByRole("link", { name: "Switch backend" });
  await button.click();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(requests, 1);
  await logo.goto("https://remote.test/");
  await button.focus(); await logo.keyboard.press("Enter");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(requests, 2);
  await logo.goto("https://remote.test/");
  await logo.locator(".brand").evaluate(element => element.remove());
  await logo.getByRole("button", { name: "Switch backend" }).waitFor({ state: "visible" });
  await logo.getByRole("button", { name: "Switch backend" }).click();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(requests, 3);
  console.log("Backend manager and logo bridge browser checks passed.");
} finally {
  await browser.close();
}
