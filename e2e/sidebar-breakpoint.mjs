import assert from "node:assert/strict";

export async function checkSidebarBreakpoint(page) {
  const sidebar = page.locator("#session-sidebar");
  const resize = async (width) => {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForFunction((mobile) => window.matchMedia("(max-width: 640px)").matches === mobile, width <= 640);
  };
  const expectOpen = async (open) => {
    await page.waitForFunction((expected) => document.getElementById("session-sidebar")?.classList.contains("sidebar-open") === expected, open);
    assert.equal(await sidebar.evaluate((node) => node.classList.contains("sidebar-open")), open);
  };
  await resize(1280);
  await expectOpen(true);
  await resize(390);
  await expectOpen(false);
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await expectOpen(true);
  await page.locator(".sidebar-overlay-backdrop").click({ position: { x: 380, y: 500 } });
  await expectOpen(false);
  await resize(1280);
  await expectOpen(true);
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await expectOpen(false);
  await resize(390);
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await expectOpen(true);
  await resize(1280);
  await expectOpen(false);
  // Keyboard reopening also works while hover preview covers the pointer trigger.
  await page.getByRole("button", { name: "Show sidebar", exact: true }).press("Enter");
  const originalUrl = page.url();
  const collapsedUrl = new URL(originalUrl);
  collapsedUrl.searchParams.set("sidebar", "collapsed");
  await page.goto(collapsedUrl.href);
  await expectOpen(false);
  await resize(390);
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await expectOpen(true);
  await resize(1280);
  await expectOpen(false);
  await page.goto(originalUrl);
  await expectOpen(true);
  console.log("PASS: desktop sidebar preference survives mobile drawer and backdrop actions");
}
