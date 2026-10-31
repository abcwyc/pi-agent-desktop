import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readProjectPreferences, changeProjectPreferences } = await jiti.import("../lib/project-preferences.ts");
const storage = await mkdtemp(join(tmpdir(), "pi-project-rename-"));
import { createServer } from "node:http";
import { chromium } from "playwright";

const out = "test-results/project-rename";
await mkdir(out, { recursive: true });
await build({ entryPoints: ["e2e/project-rename.fixture.tsx"], bundle: true, platform: "browser", format: "iife",
  outfile: out + "/fixture.js", define: { "process.env.NODE_ENV": '"production"' }, jsx: "automatic", logLevel: "warning" });
const js = await readFile(out + "/fixture.js");
const css = (await Promise.all(["app/globals.css", "app/settings.css", "app/native-theme.css"].map((p) => readFile(p, "utf8"))))
  .map((text) => text.replace(/^@import[^;]*;/gm, "")).join("\n");
const serve = (req, res) => {
  res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/style.css" ? "text/css" : "text/html; charset=utf-8");
  res.end(req.url === "/fixture.js" ? js : req.url === "/style.css" ? css : '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body style="margin:0"><div id="root"></div><script src="/fixture.js"></script></body></html>');
};
const server = createServer(serve), secondServer = createServer(serve);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await new Promise((resolve) => secondServer.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, channel: process.env.E2E_BROWSER_CHANNEL || "chrome" });
const base = "http://127.0.0.1:" + server.address().port;
try {
  for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
    const path = join(storage, `${theme}-${width}.json`);
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript((theme) => {
      localStorage.setItem("pi-locale", "zh-CN");
      document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.toggle("dark", theme === "dark"));
    }, theme);
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      let data = {};
      if (url.pathname === "/api/project-preferences") {
        data = route.request().method() === "POST"
          ? changeProjectPreferences(route.request().postDataJSON(), path) : readProjectPreferences(path);
      }
      if (url.pathname === "/api/sessions") data = { sessions: ["D:/work/app", "D:/other/app"].map((cwd, i) => ({
        id: "session-" + i, path: cwd + "/session.jsonl", cwd, projectRoot: cwd, projectKey: cwd.toLowerCase(), workspaceKind: "project",
        timestamp: "2026-10-30T10:00:00Z", modified: "2026-10-30T10:00:00Z", firstMessage: "Example", messageCount: 2,
      })) };
      if (url.pathname === "/api/worktrees") data = { projectRoot: "D:/work/app", isGit: false, worktrees: [], branches: [], remoteBranches: [] };
      if (url.pathname === "/api/home") data = { home: "D:/" };
      if (url.pathname.includes("running")) data = { running: [] };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto(base);
    // Scope to the actual project header instead of session action buttons.
    const openRename = async () => {
      const row = page.locator('.sidebar-project-tree-row').filter({ hasText: /work\/app|业务 A/ });
      await row.hover();
      await row.locator('button[aria-haspopup="menu"]').click();
      await page.getByRole("menuitem", { name: "重命名项目", exact: true }).click();
    };
    await openRename();
    const input = page.getByRole("textbox", { name: "项目名称", exact: true });
    await input.waitFor();
    assert.equal(await input.evaluate((el) => el === document.activeElement), true);
    await input.fill("业务 A");
    await input.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
    assert.equal(await input.count(), 1, "IME Enter must not submit");
    await page.screenshot({ path: `${out}/${theme}-${width}.png` });
    const rect = await page.getByRole("dialog").boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1, "dialog fits viewport");
    const renamed = page.waitForResponse(r => r.url().endsWith("/api/project-preferences") && r.request().method() === "POST" && r.request().postDataJSON()?.action === "rename");
    await input.press("Enter");
    await renamed;
    await page.locator('.sidebar-project-tree-name').getByText("业务 A", { exact: true }).waitFor();
    assert.equal(await page.locator('.chat-project-context').innerText(), "业务 A");
    // Remove a second project, then change origin (like a desktop cold start).
    const removedRow = page.locator('.sidebar-project-tree-row').filter({ hasText: "other/app" });
    await removedRow.hover();
    await removedRow.locator('button[aria-haspopup="menu"]').click();
    const archived = page.waitForResponse(r => r.url().endsWith("/api/project-preferences") && r.request().method() === "POST" && r.request().postDataJSON()?.action === "archive");
    await page.getByRole("menuitem", { name: "移除项目", exact: true }).click();
    await archived;
    await page.addInitScript(() => {
      localStorage.setItem("pi-web:project-names", JSON.stringify({ "d:/work/app": "过时名称" }));
      localStorage.setItem("pi-web:archived-projects", "[]");
    });
    await page.goto("http://127.0.0.1:" + secondServer.address().port);
    // New origin has no original localStorage; only server-side data can restore this.

    await page.locator('.sidebar-project-tree-name').getByText("业务 A", { exact: true }).waitFor();
    assert.equal(await removedRow.count(), 0, "removed project stays hidden across origins");
    assert.equal(readProjectPreferences(path).names["d:/work/app"], "业务 A");
    await openRename();
    await input.fill("取消的名称");
    await input.press("Escape");
    assert.equal(await page.locator('.chat-project-context').innerText(), "业务 A");
    await page.route("**/api/project-preferences", async route => {
      if (route.request().method() === "POST" && route.request().postDataJSON()?.name === "保存失败") {
        await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Disk unavailable"}' });
      } else await route.fallback();
    });
    await openRename();
    await input.fill("保存失败");
    const failed = page.waitForResponse(r => r.url().endsWith("/api/project-preferences") && r.status() === 500);
    await input.press("Enter");
    await failed;
    await page.locator('.sidebar-project-tree-name').getByText("业务 A", { exact: true }).waitFor();
    assert.equal(readProjectPreferences(path).names["d:/work/app"], "业务 A", "failed save preserves the last persisted value");
    await openRename();
    await input.fill("");
    const reset = page.waitForResponse(r => r.url().endsWith("/api/project-preferences") && r.request().method() === "POST" && r.request().postDataJSON()?.action === "rename");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await reset;
    await page.locator('.sidebar-project-tree-name').getByText(/^(work\/)?app$/).waitFor();
    assert.deepEqual(readProjectPreferences(path).names, {});
    await page.reload();
    await page.locator('.sidebar-project-tree-name').getByText(/^(work\/)?app$/).waitFor();
    assert.equal(await removedRow.count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS rename, IME, cancel, reset, persistence: ${theme} ${width}px`);
  }
} finally {
  await browser.close();
  await Promise.all([server, secondServer].map(s => new Promise(resolve => s.close(resolve))));
  await rm(storage, { recursive: true, force: true });
}
