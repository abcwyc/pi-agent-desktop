// The gear opens Settings directly and restores the last section. Select the
// requested section inside the dialog, using its desktop or mobile navigation.
export async function openSettingsSection(page, section) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.waitFor();
  const tab = dialog.locator(".settings-section-tabs").getByRole("button", { name: section, exact: true });
  if (await tab.isVisible()) {
    await tab.click();
  } else {
    await dialog.locator(".settings-mobile-section-picker").click();
    await page.getByRole("option", { name: section, exact: true }).click();
  }
  return dialog;
}
