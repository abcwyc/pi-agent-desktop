// The gear opens Settings directly and restores the last section. Select the
// requested section inside the dialog, using its desktop tabs or, on a phone,
// the list of sections the gear opens on (P1's drill-down).
export async function openSettingsSection(page, section) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.waitFor();
  const tab = dialog.locator(".settings-section-tabs").getByRole("button", { name: section, exact: true });
  if (await tab.isVisible()) {
    await tab.click();
  } else {
    const home = dialog.locator(".settings-phone-home");
    while (!(await home.isVisible())) await dialog.locator(".settings-phone-back").click();
    await home.getByRole("button", { name: section }).click();
  }
  return dialog;
}
