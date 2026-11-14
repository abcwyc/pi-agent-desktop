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

const { buildModelsListUrl, collectModelPages, nextModelsPageUrl, parseDiscoveredModels } = await loadSubject("./model-discovery.ts");
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

function anthropicPages(pages) {
  const requested = [];
  const fetchPage = async (url) => {
    requested.push(url.toString());
    const after = url.searchParams.get("after_id") ?? "";
    const page = pages[after];
    if (typeof page === "function") return page();
    return { ok: true, payload: page };
  };
  return { requested, fetchPage };
}

const anthropicFirst = buildModelsListUrl("https://api.anthropic.com", "anthropic-messages");

test("collects every page until the upstream reports no more (#198)", async () => {
  const { requested, fetchPage } = anthropicPages({
    "": { data: [{ id: "a" }], has_more: true, last_id: "a" },
    a: { data: [{ id: "b" }], has_more: false, last_id: "b" },
  });
  const result = await collectModelPages({ firstUrl: anthropicFirst, api: "anthropic-messages", maxPages: 20, fetchPage });
  assert.equal(result.ok, true);
  assert.equal(result.pages.length, 2);
  assert.equal(requested.length, 2);
});

test("reports a list cut short by the page budget instead of returning part of it (#198)", async () => {
  let n = 0;
  const fetchPage = async () => {
    n += 1;
    return { ok: true, payload: { data: [{ id: `m${n}` }], has_more: true, last_id: `m${n}` } };
  };
  const result = await collectModelPages({ firstUrl: anthropicFirst, api: "anthropic-messages", maxPages: 3, fetchPage });
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.match(result.error, /more than 3 pages/);
  assert.equal(n, 3);
});

test("a final page exactly at the budget is complete, not cut short (#198)", async () => {
  const { fetchPage } = anthropicPages({
    "": { data: [{ id: "a" }], has_more: true, last_id: "a" },
    a: { data: [{ id: "b" }], has_more: false },
  });
  const result = await collectModelPages({ firstUrl: anthropicFirst, api: "anthropic-messages", maxPages: 2, fetchPage });
  assert.equal(result.ok, true);
});

test("stops on a repeated cursor instead of looping or returning part of the list (#198)", async () => {
  const { requested, fetchPage } = anthropicPages({
    "": { data: [{ id: "a" }], has_more: true, last_id: "a" },
    a: { data: [{ id: "b" }], has_more: true, last_id: "a" },
  });
  const result = await collectModelPages({ firstUrl: anthropicFirst, api: "anthropic-messages", maxPages: 20, fetchPage });
  assert.equal(result.ok, false);
  assert.match(result.error, /repeated a page cursor/);
  assert.equal(requested.length, 2);
});

test("an auth failure on a later page fails the walk with the upstream status (#198)", async () => {
  const { fetchPage } = anthropicPages({
    "": { data: [{ id: "a" }], has_more: true, last_id: "a" },
    a: () => ({ ok: false, status: 401, error: "invalid x-api-key" }),
  });
  const result = await collectModelPages({ firstUrl: anthropicFirst, api: "anthropic-messages", maxPages: 20, fetchPage });
  assert.deepEqual(result, { ok: false, status: 502, error: "invalid x-api-key", upstreamStatus: 401 });
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

test("keeps capability metadata a gateway publishes (#856)", () => {
  assert.deepEqual(parseDiscoveredModels({
    data: [{
      id: "glm-5.3",
      object: "model",
      context_length: 1000000,
      max_output_tokens: 64000,
      supports_reasoning: true,
      default_effort: "high",
      can_disable_thinking: true,
      supported_efforts: ["low", "high", "max"],
    }],
  }), [{
    id: "glm-5.3",
    reasoning: true,
    // Unadvertised levels are unsupported; max is offered only when mapped.
    thinkingLevelMap: { minimal: null, medium: null, xhigh: null, max: "max" },
    contextWindow: 1000000,
    maxTokens: 64000,
  }]);
  assert.deepEqual(parseDiscoveredModels({
    models: [{
      name: "models/gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      inputTokenLimit: 1048576,
      outputTokenLimit: "65536",
      thinking: true,
    }],
  }), [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true, contextWindow: 1048576, maxTokens: 65536 }]);
});

test("ignores junk and ambiguous capability values (#856)", () => {
  assert.deepEqual(parseDiscoveredModels({
    data: [
      { id: "junk", context_length: 0, max_output_tokens: "abc", supports_reasoning: "yes", supported_efforts: ["high"] },
      // max_tokens means either limit depending on the gateway.
      { id: "ambiguous", max_tokens: 8192, contextWindow: 12.5 },
      { id: "efforts-only", supports_reasoning: true, supported_efforts: ["none", 3] },
      { id: "empty-efforts", reasoning: true, supported_efforts: [] },
    ],
  }), [
    { id: "ambiguous" },
    { id: "efforts-only", reasoning: true },
    { id: "empty-efforts", reasoning: true },
    { id: "junk" },
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
