import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createE2EServerEnv } from "../scripts/e2e-server-env.mjs";

// Real AppShell and notice shelf; only the title model response is synthetic.
// All session writes go to this test's private agent directory, never user data.
const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = join(root, "test-results/title-feedback");
await mkdir(artifacts, { recursive: true });
const agent = await mkdtemp(join(artifacts, "agent-"));
const workspace = join(agent, "workspace");
await mkdir(join(agent, "sessions/test"), { recursive: true });
await mkdir(workspace);
const first = "title-feedback-first";
const second = "title-feedback-other";
const timestamp = "2026-10-27T00:00:00.000Z";
for (const [id, name] of [[first, "Title target"], [second, "Other conversation"]]) {
  await writeFile(join(agent, `sessions/test/${id}.jsonl`), [
    { type: "session", version: 3, id, timestamp, cwd: workspace },
    { type: "session_info", id: "name", parentId: null, timestamp, name },
    { type: "message", id: "message", parentId: "name", timestamp,
      message: { role: "user", content: `Synthetic ${name} message` } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
}

const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise(resolveClose => probe.close(resolveClose));
const origin = `http://127.0.0.1:${port}`;
const mode = process.env.E2E_SERVER_MODE || "dev";
const env = createE2EServerEnv(process.env, agent, mode);
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_DOWNLOAD_DIR", "APPDATA", "LOCALAPPDATA"]) {
  await mkdir(env[key], { recursive: true });
}
const resources = process.env.TITLE_FEEDBACK_RESOURCES && resolve(root, process.env.TITLE_FEEDBACK_RESOURCES);
const node = resources ? join(resources, "node/node.exe") : process.execPath;
const args = resources ? ["desktop-server.cjs"]
  : [join(root, "node_modules/next/dist/bin/next"), mode, "-H", "127.0.0.1", "-p", String(port)];
Object.assign(env, { PORT: String(port), HOSTNAME: "127.0.0.1", PI_WEB_PARENT_PID: String(process.pid),
  PI_DESKTOP_API_TOKEN: "title-test", PI_DESKTOP_INSTANCE_ID: "title-test",
  PI_DESKTOP_COMPILE_CACHE_DIR: join(agent, "compile-cache") });
const logs = [];
const server = spawn(node, args, { cwd: resources ? join(resources, "server") : root,
  env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
server.stdout.on("data", data => logs.push(String(data)));
server.stderr.on("data", data => logs.push(String(data)));
let browser;
let page;
try {
  let ready = false;
  for (let i = 0; i < 240; i++) {
    try { ready = (await fetch(`${origin}/api/sessions`)).ok; } catch {}
    if (ready) break;
    if (server.exitCode !== null) throw new Error(logs.join(""));
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  assert.ok(ready, logs.join(""));
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let responseKind = "auth";
  let calls = 0;
  let release;
  const defer = () => new Promise(resolveResponse => { release = resolveResponse; });
  let gate = defer();
  await page.route(`**/api/sessions/${first}/auto-name`, async route => {
    calls++;
    await gate;
    if (responseKind === "auth") {
      await route.fulfill({ status: 500, json: { error: "401: authentication_error: invalid_api_key" } });
    } else {
      const response = await context.request.patch(`${origin}/api/sessions/${first}`, { data: { name: responseKind } });
      assert.ok(response.ok());
      await route.fulfill({ json: { title: responseKind } });
    }
  });
  const openMore = () => page.locator(".app-topbar-more-trigger").click();
  const generate = async () => {
    await openMore();
    await page.locator(".app-topbar-more-menu .app-topbar-more-title").click();
  };
  const notice = page.locator(".app-notice-item");
  await page.goto(`${origin}/?session=${first}`);
  await page.getByText("Synthetic Title target message", { exact: true }).waitFor();
  await generate();
  await page.getByText("Generating a conversation title…", { exact: true }).waitFor();
  assert.equal(await page.getByRole("menu").count(), 0, "progress remains visible after menu closes");
  const geometry = await page.evaluate(() => ({
    toolbarBottom: document.querySelector(".app-topbar").getBoundingClientRect().bottom,
    noticeTop: document.querySelector(".app-notice-item").getBoundingClientRect().top,
  }));
  assert.ok(geometry.noticeTop >= geometry.toolbarBottom + 8, "notice must leave the toolbar reachable");
  await openMore();
  assert.ok(await page.locator(".app-topbar-more-menu .app-topbar-more-title").isDisabled());
  assert.equal(calls, 1);
  await page.keyboard.press("Escape");
  release();
  await page.getByText(/The conversation model rejected its API key/).waitFor();
  // This exceeds both the old menu's five-second error reset and normal toast TTL.
  await page.waitForTimeout(7600);
  assert.equal(await notice.count(), 1);
  assert.ok(await notice.isVisible());
  await page.screenshot({ path: join(artifacts, "authentication-error.png") });
  await page.getByRole("button", { name: "Model settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.waitFor();
  assert.equal(await settings.locator('.settings-section-tabs [aria-current="page"]').textContent(), "Models");
  await settings.locator(".settings-dialog-close").click();
  await settings.waitFor({ state: "detached" });

  // Leave the error visible this time, then retry: the same notice becomes progress.
  gate = defer();
  await generate(); release();
  await page.getByText(/The conversation model rejected its API key/).waitFor();
  gate = defer(); responseKind = "Generated fixture title";
  await page.waitForTimeout(5100); // menu error label resets; notice itself must persist
  await generate();
  await page.getByText("Generating a conversation title…", { exact: true }).waitFor();
  assert.equal(await notice.count(), 1, "retry replaces the previous error");
  assert.equal(await page.getByRole("button", { name: "Model settings", exact: true }).count(), 0);
  release();
  await page.getByText("Conversation title updated: Generated fixture title", { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector(".app-topbar-title > span")?.textContent === "Generated fixture title");
  await page.locator(".session-item-title").getByText("Generated fixture title", { exact: true }).waitFor();

  gate = defer(); responseKind = "Background generated title";
  await generate();
  await page.locator(".session-item").filter({ hasText: "Other conversation" }).click();
  await page.getByText("Synthetic Other conversation message", { exact: true }).waitFor();
  release();
  await page.getByText("Conversation title updated: Background generated title", { exact: true }).waitFor();
  assert.equal(await page.locator(".app-topbar-title > span").innerText(), "Other conversation");
  await page.locator(".session-item-title").getByText("Background generated title", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  const localized = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", colorScheme: "dark" });
  await localized.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
  const narrowPage = await localized.newPage();
  await narrowPage.route(`**/api/sessions/${first}/auto-name`, route =>
    route.fulfill({ status: 500, json: { error: "401: authentication_error" } }));
  await narrowPage.goto(`${origin}/?session=${first}`);
  await narrowPage.getByText("Synthetic Title target message", { exact: true }).waitFor();
  await narrowPage.locator(".app-topbar-more-trigger").click();
  await narrowPage.locator(".app-topbar-more-menu .app-topbar-more-title").click();
  await narrowPage.getByText(/当前会话的模型认证失败/).waitFor();
  const fits = await narrowPage.locator(".app-notice-item").evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
  });
  assert.ok(fits, "localized error and action must fit on a narrow screen");
  await narrowPage.screenshot({ path: join(artifacts, "authentication-error-zh-narrow.png") });
  await localized.close();
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ passed: true, calls,
    checks: ["visible progress", "no duplicate submission", "persistent authentication error", "Models shortcut",
      "retry replaces error", "success updates header and sidebar", "session-switch isolation"],
    syntheticModelResponses: true, resources: resources || null }, null, 2));
  console.log("PASS: title feedback in real AppShell: progress, auth error, settings, retry, success and session switching");
} catch (error) {
  await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  await writeFile(join(artifacts, "server.log"), logs.join(""));
  await rm(agent, { recursive: true, force: true });
}
