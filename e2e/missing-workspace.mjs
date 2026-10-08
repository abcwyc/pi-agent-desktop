import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";

export const MISSING_WORKSPACE = "e2e-missing-workspace-session";
export const missingWorkspaceReply = "E2E missing workspace reply";

// A session whose project folder was deleted outside the app (#1061): its
// history stays readable, the composer says the folder is gone instead of
// reporting a model error, and no prompt can start there until it is back.
export async function checkMissingWorkspace(browser, base, folder) {
  await rm(folder, { recursive: true, force: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (event) => {
      // The folder's own 4xx answers are expected; anything logged by the app is not.
      if (event.type() === "error" && !event.text().startsWith("Failed to load resource")) errors.push(event.text());
    });

    await page.goto(`${base}/?session=${MISSING_WORKSPACE}`, { waitUntil: "domcontentloaded" });
    await page.getByText(missingWorkspaceReply, { exact: true }).waitFor();
    const notice = page.locator("[data-workspace-unavailable='missing']");
    await notice.waitFor();
    assert.equal(await page.getByText("Model error", { exact: true }).count(), 0, "A deleted folder is not a model error");

    const draft = "E2E draft for a deleted folder";
    const composer = page.locator("textarea").last();
    await composer.fill(draft);
    const send = page.getByRole("button", { name: "Send", exact: true });
    assert.equal(await send.isDisabled(), true, "Send must be blocked while the folder is gone");
    await composer.press("Enter");
    assert.equal(await composer.inputValue(), draft, "A blocked send keeps the draft");

    await mkdir(folder);
    await notice.getByRole("button", { name: "Check again", exact: true }).click();
    await notice.waitFor({ state: "detached" });
    assert.equal(await send.isDisabled(), false, "Restoring the folder unlocks Send");
    assert.equal(await composer.inputValue(), draft);
    assert.deepEqual(errors, [], "Browser errors for a deleted workspace");
    console.log("PASS: deleted workspace keeps history, blocks new runs, and recovers when restored");
  } finally {
    await context.close();
  }
}
