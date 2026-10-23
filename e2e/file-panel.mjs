import assert from "node:assert/strict";

// overflow-anchor:none keeps the scrollY assertion about state preservation:
// with anchoring on, the text reflowing from a narrow split (~200px on Linux
// fonts) to full width legitimately shifts scrollY (120 → 83 in CI).
export const filePanelFixture = `<!doctype html><html><head><link rel="stylesheet" href="preview.css"></head><body style="margin:20px;min-height:2400px;overflow-anchor:none">
<label>Notes <input id="notes"></label>
<label>Filter <select id="filter"><option>All</option><option>Pending</option></select></label>
<p>HTML preview state must survive layout changes.</p>
<script>window.previewInstance = Math.random();</script></body></html>`;
// Loaded by relative path: proves the static preview is served from the file's
// directory rather than rendered from a detached srcDoc.
export const filePanelStylesheet = "#notes { outline: 3px solid rgb(1, 2, 3); }";

export async function checkFilePanel(page, filePath) {
  const hideSidebar = page.getByRole("button", { name: "Hide sidebar", exact: true });
  if (await page.locator("#session-sidebar").evaluate((element) => element.classList.contains("sidebar-open"))) {
    await hideSidebar.click();
  }
  const panel = page.locator("#file-panel");
  const showPanel = page.viewportSize().width <= 640
    ? page.locator('.right-panel-toggle-button[aria-label="Show workspace"]')
    : page.locator('.app-topbar button[aria-label="Show workspace"]');
  const hidePanel = page.viewportSize().width <= 640
    ? page.locator('#file-panel [aria-label="Hide workspace"]')
    : page.locator('.app-topbar button[aria-label="Hide workspace"]');
  // The strip's own chip exists only while the topbar toggle is unreachable
  // (full-width desktop, and mobile where the floating toggle sits under the
  // panel), so closing from full width has to use it.
  const hidePanelInStrip = page.locator('#file-panel [aria-label="Hide workspace"]');
  await showPanel.click();
  await panel.waitFor({ state: "visible" });
  // The panel opens as a preview surface; the file list starts hidden.
  const showFileList = panel.locator('.file-tree-toggle[aria-label="Show file list"]');
  if (await showFileList.isVisible()) await showFileList.click();
  // The file tree normalizes Windows separators to forward slashes.
  await panel.getByRole("button").and(panel.getByTitle(filePath.replaceAll("\\", "/"), { exact: true })).click();
  const iframe = panel.locator("iframe");
  await iframe.waitFor();
  const frame = await (await iframe.elementHandle()).contentFrame();
  await frame.locator("#notes").waitFor();
  // Static preview: local CSS resolves, scripts stay off (sandbox + route CSP).
  assert.equal(await frame.locator("#notes").evaluate((el) => getComputedStyle(el).outlineColor), "rgb(1, 2, 3)");
  assert.equal(await frame.evaluate(() => window.previewInstance), undefined, "The static HTML preview must not run scripts");
  await frame.locator("#notes").fill("Keep this note");
  await frame.locator("#filter").selectOption({ label: "Pending" });
  await frame.evaluate(() => scrollTo(0, 120));
  const instance = await frame.evaluate(() => window.previewInstance);
  const width = () => panel.evaluate(async el => {
    await new Promise(requestAnimationFrame);
    await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
    return el.getBoundingClientRect().width;
  });
  const storedWidths = () => page.evaluate(() => [
    localStorage.getItem("pi-sidebar-width"), localStorage.getItem("pi-right-panel-width"),
  ]);
  const toggle = panel.getByRole("button", { name: "Expand panel to full width", exact: true });
  if (page.viewportSize().width <= 640) {
    assert.equal(await toggle.isVisible(), false, "Mobile already uses full width");
  } else {
    // Include a manually resized split in the round trip.
    const separator = page.locator('[data-resize-handle="right-panel"]');
    if (await separator.isVisible()) await separator.press("ArrowLeft");
    const originalWidth = await width();
    const originalStored = await storedWidths();
    // The fork keeps session stats in the topbar's More menu (upstream had a
    // dedicated "Session info" button); the strip's hide-panel chip is gone
    // too — the topbar panel toggle owns closing on desktop, the fixed
    // floating toggle on mobile.
    const moreTrigger = page.getByRole("button", { name: "More session actions", exact: true });
    const statsItem = page.locator(".app-topbar-more-menu .app-topbar-more-item").last();
    const sessionPopover = page.locator(".session-info-popover");
    const openSessionInfo = async () => {
      await moreTrigger.click();
      await statsItem.click();
      await sessionPopover.waitFor();
    };
    for (let i = 0; i < 2; i++) {
      await openSessionInfo();
      await toggle.click();
      assert.equal(await sessionPopover.count(), 0, "Full-width mode dismisses inert top-bar menus");
      assert.equal(await panel.getByRole("button", { name: "Restore panel width", exact: true }).getAttribute("aria-pressed"), "true");
      assert.equal(Math.round(await width()), page.viewportSize().width);
      assert.equal(await page.locator("#session-sidebar").evaluate(el => el.inert), true);
      assert.equal(await frame.evaluate(() => window.previewInstance), instance);
      assert.equal(await frame.evaluate(() => scrollY), 120);
      assert.equal(await frame.locator("#notes").inputValue(), "Keep this note");
      assert.equal(await frame.locator("#filter").inputValue(), "Pending");
      await panel.getByRole("button", { name: "Restore panel width", exact: true }).press("Enter");
      assert.equal(await width(), originalWidth);
      assert.deepEqual(await storedWidths(), originalStored);
      assert.equal(await page.locator("#session-sidebar").evaluate(el => el.inert), false);
    }
    await toggle.click();
    await hidePanelInStrip.click();
    await showPanel.click();
    assert.equal(await toggle.getAttribute("aria-pressed"), "false", "Reopening returns to the split layout");
    assert.equal(await width(), originalWidth);
    assert.equal(await frame.evaluate(() => window.previewInstance), instance);
  }
  // Opting into scripts swaps to an isolated srcDoc sandbox where they run.
  const runScripts = panel.getByRole("button", { name: "Run scripts", exact: true });
  await runScripts.click();
  assert.equal(await runScripts.getAttribute("aria-pressed"), "true");
  const scriptedFrame = await (await panel.locator("iframe[srcdoc]").elementHandle()).contentFrame();
  await scriptedFrame.waitForFunction(() => typeof window.previewInstance === "number");
  await runScripts.click();
  await panel.locator("iframe:not([srcdoc])").waitFor();
  await hidePanel.click();
  console.log(`PASS: file panel width and preview state at ${page.viewportSize().width}px`);
}
