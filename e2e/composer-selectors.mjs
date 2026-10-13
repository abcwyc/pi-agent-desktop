import assert from "node:assert/strict";

export async function checkComposerSelectors(page) {
  const row = page.locator(".session-item").filter({ hasText: "Branch root" });
  const initialUrl = page.url();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as Unread", exact: true }).click();
  assert.match(await row.getAttribute("class"), /is-unread/);
  assert.equal(page.url(), initialUrl, "marking unread does not select the session");
  await page.reload({ waitUntil: "domcontentloaded" });
  await row.waitFor();
  assert.match(await row.getAttribute("class"), /is-unread/, "unread survives refresh");
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as Read", exact: true }).click();
  assert.doesNotMatch(await row.getAttribute("class"), /is-unread/);
  await row.hover();
  await row.locator(".session-item-more").click();
  await page.getByRole("menuitem", { name: "Mark as Unread", exact: true }).click();
  await row.click();
  assert.doesNotMatch(await row.getAttribute("class"), /is-unread/, "opening the session marks it read");
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as Unread", exact: true }).click();
  assert.match(await row.getAttribute("class"), /is-unread/, "the selected session can be marked unread");
  await row.click();
  assert.doesNotMatch(await row.getAttribute("class"), /is-unread/, "reopening the selected session clears unread");

  const input = page.locator(".chat-input-textarea").last();
  for (const prefix of ["请参考", "first line\n正文："]) {
    for (const [token, expected, option] of [
      ["/sess", "/session ", page.getByRole("button", { name: /^\/session\b/ })],
      ["@preview.ht", "@preview.html ", page.locator("button").filter({ hasText: /^preview\.html$/ })],
      ["#Branch", '#"Branch root" ', page.getByRole("button", { name: /^Branch root Branch root$/ })],
    ]) {
      await input.fill(prefix + "后文");
      await input.evaluate((el, position) => {
        el.focus();
        el.setSelectionRange(position, position);
      }, prefix.length);
      await input.pressSequentially(token);
      await option.waitFor();
      await input.press("Tab");
      assert.equal(await input.inputValue(), prefix + expected + "后文", "completion preserves surrounding text");
    }
  }
  await input.fill("");
  await page.goto(initialUrl, { waitUntil: "domcontentloaded" });
  await page.locator(".markdown-code-block pre").waitFor();
  console.log("PASS: session context menus, read state, and selectors inside text");
}
