import assert from "node:assert/strict";

// Keep account credentials and upstream services outside this UI boundary.
// The route tests separately exercise the real writer and SDK model resolution.
export async function checkModelContext(page) {
  let saved = { providers: { relay: { models: [{ id: "keep-me" }] } } };
  let rejectSave = false;
  let writes = 0;
  const routes = ["**/api/models-config", "**/api/auth/providers", "**/api/models/enabled*", "**/api/provider-usage/query"];
  await page.route(routes[0], (route) => {
    if (route.request().method() === "PUT") {
      writes++;
      if (rejectSave) return route.fulfill({ json: { error: "Fixture save unavailable" } });
      saved = route.request().postDataJSON();
      return route.fulfill({ json: { success: true } });
    }
    return route.fulfill({ json: saved });
  });
  await page.route(routes[1], (route) => route.fulfill({ json: {
    oauthProviders: [{ id: "openai-codex", name: "OpenAI Codex", loggedIn: true }], apiKeyProviders: [],
  } }));
  await page.route(routes[2], (route) => route.fulfill({ json: {
    allEnabled: true, patterns: null, stalePatterns: [], enabledTotal: 1, availableTotal: 1,
    scope: "global", settingsPath: "models-fixture/settings.json", editable: true,
    providers: [{ id: "openai-codex", name: "OpenAI Codex", kind: "builtin", enabledCount: 1, models: [{
      id: "gpt-6-astra", name: "GPT-6 Astra", ref: "openai-codex/gpt-6-astra", enabled: true,
      contextWindow: saved.providers["openai-codex"]?.modelOverrides?.["gpt-6-astra"]?.contextWindow ?? 272000,
    }] }],
  } }));
  await page.route(routes[3], (route) => route.fulfill({ json: { providers: [] } }));
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const open = async () => {
    const sidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
    if (await sidebar.isVisible()) await sidebar.click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const section = settings.getByRole("combobox", { name: "Settings", exact: true });
    if (await section.isVisible()) await section.selectOption("models");
    else await settings.getByRole("button", { name: "Models", exact: true }).click();
    await settings.locator(".config-sidebar-item").filter({ hasText: "OpenAI Codex" }).click();
  };
  const input = settings.getByRole("textbox", { name: "Context window for GPT-6 Astra", exact: true });
  const save = async () => {
    const response = page.waitForResponse((reply) => reply.url().endsWith("/api/models-config") && reply.request().method() === "PUT");
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await response;
    await input.waitFor({ state: "visible" });
  };
  try {
    await open();
    assert.equal(await input.getAttribute("placeholder"), "272000", "A blank field shows the window pi resolves");
    const name = input.locator("xpath=..").locator(".enabled-models-row-text");
    const [field, text] = await Promise.all([input.boundingBox(), name.boundingBox()]);
    assert.ok(Math.abs(field.y + field.height / 2 - (text.y + text.height / 2)) < 4 && field.height <= text.height,
      "The input sits on the model's line without making the row taller");
    await input.fill("500000");
    assert.equal(writes, 0, "Editing must wait for the shared Save button");
    await save();
    assert.equal(saved.providers["openai-codex"].modelOverrides["gpt-6-astra"].contextWindow, 500000);
    assert.deepEqual(saved.providers.relay, { models: [{ id: "keep-me" }] });
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await open();
    assert.equal(await input.inputValue(), "500000");
    assert.equal(await settings.locator(".config-sidebar-item").filter({ hasText: /^openai-codex$/ }).count(), 0,
      "An override-only entry must not create a duplicate custom provider");

    await input.fill("500k");
    assert.equal(await input.getAttribute("aria-invalid"), "true");
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await settings.getByText("Context window of openai-codex/gpt-6-astra: enter a positive whole number of tokens.", { exact: true }).waitFor();
    assert.equal(writes, 1, "Invalid input must not reach the writer");
    assert.equal(await input.inputValue(), "500k", "Invalid drafts must not be truncated to 500");

    await input.fill("600000");
    rejectSave = true;
    await save();
    await settings.getByText("Fixture save unavailable", { exact: true }).waitFor();
    assert.equal(await input.inputValue(), "600000", "A failed save preserves the editable draft");
    assert.equal(saved.providers["openai-codex"].modelOverrides["gpt-6-astra"].contextWindow, 500000);
    rejectSave = false;
    await save();
    assert.equal(saved.providers["openai-codex"].modelOverrides["gpt-6-astra"].contextWindow, 600000);

    const bounds = await input.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width,
      "The input remains within the viewport at desktop and phone widths");
    await input.fill("");
    await save();
    assert.deepEqual(saved, { providers: { relay: { models: [{ id: "keep-me" }] } } });
    // The placeholder is what pi resolves, so it shows the default again once the cleared field is saved.
    await settings.locator('input[aria-label="Context window for GPT-6 Astra"][placeholder="272000"]').waitFor();
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    console.log("PASS: account context edit/save/reopen/validation/retry/clear preserve other model settings");
  } finally {
    for (const route of routes) await page.unroute(route);
  }
}
