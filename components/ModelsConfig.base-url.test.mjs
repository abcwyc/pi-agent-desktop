import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("a custom model can override its provider's Base URL (upstream #1288)", () => {
  // The field writes pi's native models[].baseUrl; blank goes back to the provider's.
  assert.match(source, /<Field label=\{t\("models\.baseUrlOverride"\)\}>\s*<TextInput value=\{model\.baseUrl \?\? ""\} onChange=\{\(v\) => set\("baseUrl", v\.trim\(\) \|\| undefined\)\}\s*placeholder=\{provider\.baseUrl \?\? t\("models\.providerDefaults"\)\} mono \/>/);
  // It sits above the API override, and the Advanced summary names it.
  assert.ok(source.indexOf('t("models.baseUrlOverride")}>') < source.indexOf('<Field label={t("models.apiOverride")}>'));
  assert.match(source, /model\.baseUrl \? t\("models\.baseUrlOverride"\) : null,/);
  // Test and the catalog lookup use the endpoint this model actually calls.
  assert.match(source, /const effectiveBaseUrl = model\.baseUrl \?\? provider\.baseUrl;/);
  assert.match(source, /if \(effectiveBaseUrl\?\.trim\(\)\) params\.set\("baseUrl", effectiveBaseUrl\.trim\(\)\);/);
});
