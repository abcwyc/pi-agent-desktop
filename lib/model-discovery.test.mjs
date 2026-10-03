import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject(path) {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import(path);
  } catch {
    return import(path);
  }
}

const { buildModelsListUrl, nextModelsPageUrl, parseDiscoveredModels } = await loadSubject("./model-discovery.ts");
const { resolveModelDiscoveryAuth } = await loadSubject("./model-discovery-auth.ts");

test("builds protocol-appropriate model list URLs", () => {
  assert.equal(buildModelsListUrl("https://api.example.com/v1/", "openai-completions").toString(), "https://api.example.com/v1/models");
  assert.equal(buildModelsListUrl("https://api.anthropic.com", "anthropic-messages").toString(), "https://api.anthropic.com/v1/models?limit=100");
  assert.equal(buildModelsListUrl("https://generativelanguage.googleapis.com", "google-generative-ai").toString(), "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100");
  assert.equal(buildModelsListUrl("https://api.example.com/custom/models", "openai-responses").toString(), "https://api.example.com/custom/models");
});

test("strips a pasted inference endpoint before appending /models", () => {
  assert.equal(
    buildModelsListUrl("https://maas-api.example.com/v1/chat/completions", "openai-completions").toString(),
    "https://maas-api.example.com/v1/models",
  );
  assert.equal(
    buildModelsListUrl("https://maas-api.example.com/v1/messages", "anthropic-messages").toString(),
    "https://maas-api.example.com/v1/models?limit=100",
  );
  assert.equal(
    buildModelsListUrl("https://maas-api.example.com/v1/chat/completions/", "openai-completions").toString(),
    "https://maas-api.example.com/v1/models",
  );
});

test("follows cursor pagination only when the API provides a cursor", () => {
  const anthropic = buildModelsListUrl("https://api.anthropic.com", "anthropic-messages");
  assert.equal(
    nextModelsPageUrl(anthropic, "anthropic-messages", { has_more: true, last_id: "model_42" })?.toString(),
    "https://api.anthropic.com/v1/models?limit=100&after_id=model_42",
  );
  assert.equal(nextModelsPageUrl(anthropic, "anthropic-messages", { has_more: false, last_id: "model_42" }), null);
  assert.equal(
    nextModelsPageUrl(anthropic, "google-generative-ai", { nextPageToken: "tok" })?.searchParams.get("pageToken"),
    "tok",
  );
  assert.equal(nextModelsPageUrl(anthropic, "openai-completions", { has_more: true, last_id: "x" }), null);
});

test("flattens model lists collected across multiple pages", () => {
  assert.deepEqual(
    parseDiscoveredModels([{ data: [{ id: "gpt-5" }] }, { data: [{ id: "claude", display_name: "Claude" }] }]),
    [{ id: "claude", name: "Claude" }, { id: "gpt-5" }],
  );
});

test("parses OpenAI, Anthropic, Google, and string model lists", () => {
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "gpt-5" }, { id: "claude", display_name: "Claude" }] }), [
    { id: "claude", name: "Claude" },
    { id: "gpt-5" },
  ]);
  assert.deepEqual(parseDiscoveredModels({ models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }] }), [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ]);
  assert.deepEqual(parseDiscoveredModels(["zeta", "alpha", "alpha"]), [
    { id: "alpha" },
    { id: "zeta" },
  ]);
});

test("resolves environment-backed headers without an API key", async () => {
  process.env.PI_WEB_DISCOVERY_TEST_TOKEN = "resolved-token";
  try {
    const auth = await resolveModelDiscoveryAuth("pi-web-header-only-test", {
      baseUrl: "https://example.invalid/v1",
      api: "openai-completions",
      headers: { "X-Discovery-Token": "$PI_WEB_DISCOVERY_TEST_TOKEN" },
    });
    assert.equal(auth.apiKey, undefined);
    assert.deepEqual(auth.headers, { "X-Discovery-Token": "resolved-token" });
  } finally {
    delete process.env.PI_WEB_DISCOVERY_TEST_TOKEN;
  }
});

test("resolves the effective base URL and API for the requested provider", async () => {
  const configured = await resolveModelDiscoveryAuth("pi-web-baseurl-test", {
    baseUrl: "https://example.invalid/v1/",
    api: "anthropic-messages",
  });
  assert.equal(configured.baseUrl, "https://example.invalid/v1/");
  assert.equal(configured.api, "anthropic-messages");

  // A models-only entry keeps the endpoint and protocol pi ships for that
  // provider, so discovery does not depend on models.json repeating the base URL.
  const builtin = await resolveModelDiscoveryAuth("deepseek", {
    models: [{ id: "deepseek-flash" }],
  });
  assert.equal(builtin.baseUrl, "https://api.deepseek.com");
  assert.equal(builtin.api, "openai-completions");
});

test("asks for a Base URL when a custom provider has none and pi ships no endpoint", async () => {
  const { createJiti } = await import("jiti");
  const { POST } = await createJiti(import.meta.url, { tsconfigPaths: true })
    .import("../app/api/models-config/discover/route.ts");
  const response = await POST(new Request("http://localhost/api/models-config/discover", {
    method: "POST",
    body: JSON.stringify({ providerName: "pi-web-no-baseurl-test", provider: {} }),
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Base URL is required" });
});
