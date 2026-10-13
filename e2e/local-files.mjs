import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const desktopTestToken = "e2e-desktop-file-save-authorization-only";

export async function checkLocalFiles(browser, base, sessionId, filePath, referencedFile, agentDir) {
  const expected = await readFile(filePath);
  for (const mode of ["macos", "windows", "browser"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    let page;
    try {
      const destPath = join(agentDir, `${mode}-saved.html`);
      await context.addInitScript(({ mode, destPath, token }) => {
        window.fileCommands = [];
        window.cancelFileSave = false;
        window.failFileAction = false;
        if (mode === "browser") return;
        Object.defineProperty(navigator, "platform", { value: mode === "windows" ? "Win32" : "MacIntel" });
        window.__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: async (cmd, args) => {
            window.fileCommands.push({ cmd, args });
            if (cmd === "plugin:dialog|save") return window.cancelFileSave ? null : destPath;
            if (cmd === "get_desktop_api_token") return token;
            if (cmd === "reveal_item_in_dir" && window.failFileAction) throw new Error("File manager unavailable");
            return false;
          },
        };
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      }, { mode, destPath, token: desktopTestToken });
      page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${base}/?session=${sessionId}`);
      await page.locator(".markdown-code-block pre").waitFor();
      const panel = page.locator("#file-panel");
      await page.locator('.app-topbar button[aria-label="Show file panel"]').click();
      const fileRow = panel.locator(`[role="button"][title="${filePath}"]`);
      await fileRow.click();
      await panel.locator("iframe").waitFor();
      const local = mode === "macos" || mode === "windows";
      const open = panel.getByRole("button", { name: "Open with default app", exact: true });
      const reveal = panel.getByRole("button", { name: mode === "windows" ? "Show in Explorer" : "Reveal in Finder", exact: true });
      if (local) {
        await open.click();
        await reveal.click();
        await page.waitForFunction(() => window.fileCommands.some(({ cmd }) => cmd === "reveal_item_in_dir"));
        assert.deepEqual(await page.evaluate(() => window.fileCommands.filter(({ cmd }) => ["open_path", "reveal_item_in_dir"].includes(cmd))), [
          { cmd: "open_path", args: { path: filePath } }, { cmd: "reveal_item_in_dir", args: { path: filePath } },
        ]);
        await page.evaluate(() => { window.failFileAction = true; });
        await reveal.click();
        await panel.getByRole("alert").filter({ hasText: "File manager unavailable" }).waitFor();
      } else {
        assert.equal(await open.count(), 0);
        assert.equal(await reveal.count(), 0);
      }
      const saveRequests = [];
      page.on("request", (request) => {
        if (request.url().endsWith("/api/desktop/save")) saveRequests.push(request);
      });
      async function download(button, bytes) {
        if (local) {
          const saved = page.waitForResponse((response) => response.url().endsWith("/api/desktop/save"));
          await button.click();
          assert.equal((await saved).status(), 200);
          assert.deepEqual(await readFile(destPath), bytes);
        } else {
          const downloaded = page.waitForEvent("download");
          await button.click();
          const result = await downloaded;
          assert.deepEqual(await readFile(await result.path()), bytes);
          assert.equal(saveRequests.length, 0, "Remote downloads must not submit client save paths to the server");
        }
      }
      await download(panel.locator(".file-viewer-controls").getByRole("button", { name: "Download file", exact: true }), expected);
      await fileRow.hover();
      await download(fileRow.getByRole("button", { name: "Download file", exact: true }), expected);
      if (local) {
        const before = saveRequests.length;
        await page.evaluate(() => { window.cancelFileSave = true; });
        await panel.locator(".file-viewer-controls").getByRole("button", { name: "Download file", exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.file-viewer-controls button[aria-label="Download file"]').disabled);
        assert.equal(saveRequests.length, before, "Cancel must not write a file");
        await page.evaluate(() => { window.cancelFileSave = false; });
      }
      // This file is outside the project roots, authorized only by the transcript link.
      await page.getByRole("link", { name: "Referenced report", exact: true }).click();
      await panel.locator(".file-viewer-path").filter({ hasText: "referenced-report.txt" }).waitFor();
      await download(panel.locator(".file-viewer-controls").getByRole("button", { name: "Download file", exact: true }), await readFile(referencedFile));
      if (local) await page.screenshot({ path: join(process.cwd(), `test-results/e2e/local-files-${mode}.png`) });
      assert.deepEqual(errors, [], `${mode} file action runtime errors`);
    } catch (error) {
      await page?.screenshot({ path: join(process.cwd(), `test-results/e2e/local-files-${mode}-failure.png`) });
      console.error(mode, await page?.locator("#file-panel").innerText());
      throw error;
    } finally {
      await context.close();
    }
  }
  console.log("PASS: local file-manager actions, preview/tree saves, cancel, session-reference downloads, and browser downloads");
}
