import assert from "node:assert/strict";
import { join } from "node:path";

export async function checkDesktopChrome(browser, base, sessionId, cwd, artifacts) {
  for (const platform of ["MacIntel", "Win32", "Linux x86_64", null]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    try {
      await context.addInitScript((platform) => {
        window.chromeCommands = [];
        if (!platform) return;
        Object.defineProperty(navigator, "platform", { value: platform });
        window.__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: async (cmd) => { window.chromeCommands.push(cmd); return false; },
        };
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      }, platform);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/project-trust?*", (route) => route.fulfill({ json: {
        cwd, trusted: false, requiresTrust: true, resources: [], mcpServers: [],
      } }));
      await page.goto(`${base}/?session=${sessionId}`);
      const warning = page.getByRole("button", { name: "Restricted mode", exact: true });
      await warning.waitFor();
      assert.equal(await warning.count(), 1, "Restricted mode must appear only once");
      const topbar = page.locator(".app-topbar");
      const bar = await topbar.boundingBox();
      const label = await warning.locator("span").boundingBox();
      assert.ok(Math.abs(label.y + label.height / 2 - bar.y - bar.height / 2) < 2,
        "Restricted mode must be vertically centered in the toolbar");
      const title = topbar.locator(".app-topbar-title > span");
      if (platform) await page.waitForSelector(".app-topbar[data-tauri-drag-region]");
      await title.dispatchEvent("mousedown", { button: 0, detail: 1 });
      if (platform) await page.waitForFunction(() => window.chromeCommands.includes("plugin:window|start_dragging"));
      const dragCount = () => page.evaluate(() => window.chromeCommands.filter((cmd) => cmd === "plugin:window|start_dragging").length);
      assert.equal(await dragCount(), platform ? 1 : 0);
      await title.dispatchEvent("mousedown", { button: 2, detail: 1 });
      await title.dispatchEvent("mousedown", { button: 0, detail: 2 });
      if (platform) await page.waitForFunction(() => window.chromeCommands.includes("plugin:window|toggle_maximize"));
      await warning.locator("svg").click();
      await page.getByRole("dialog").waitFor();
      assert.equal(await dragCount(), platform ? 1 : 0, "Interactive header children must not drag");
      await page.keyboard.press("Escape");
      const header = page.locator(".session-sidebar-header");
      await header.dispatchEvent("mousedown", { button: 0, detail: 1 });
      if (platform) await page.waitForFunction(() => window.chromeCommands.filter((cmd) => cmd === "plugin:window|start_dragging").length === 2);
      assert.equal(await dragCount(), platform ? 2 : 0);
      if (platform === "MacIntel") await page.screenshot({ path: join(artifacts, "desktop-chrome-macos.png") });
      if (!platform) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('[data-mobile-trust-banner="true"]').waitFor();
        assert.equal(await warning.count(), 1, "Mobile must have only its content banner");
        assert.equal(await topbar.getByRole("button", { name: "Restricted mode" }).count(), 0);
      }
      assert.deepEqual(errors, [], `${platform ?? "browser"} runtime errors`);
    } finally {
      await context.close();
    }
  }
  console.log("PASS: restricted-mode layout and desktop drag IPC on macOS, Windows and Linux; browser stays inert");
}
