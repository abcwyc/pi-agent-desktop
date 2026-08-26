import assert from "node:assert/strict";
import test from "node:test";

const { redactModelsJson, mergeStoredLiteralApiKeys } = await import("./models-config-redaction.ts");

test("redact drops literal apiKey values", () => {
  const redacted = redactModelsJson({
    providers: {
      custom: { baseUrl: "http://x", apiKey: "sk-literal-123", models: [] },
    },
  });
  assert.deepEqual(redacted.providers.custom, { baseUrl: "http://x", models: [] });
});

test("redact keeps shell and env references", () => {
  const redacted = redactModelsJson({
    providers: {
      a: { apiKey: "!cat ~/.key" },
      b: { apiKey: "$OPENAI_KEY" },
      c: { apiKey: "" },
    },
  });
  assert.equal(redacted.providers.a.apiKey, "!cat ~/.key");
  assert.equal(redacted.providers.b.apiKey, "$OPENAI_KEY");
  // An empty value is not a secret and is dropped like any other literal.
  assert.equal(redacted.providers.c.apiKey, undefined);
});

test("redact preserves unrelated top-level and provider fields", () => {
  const redacted = redactModelsJson({
    version: 1,
    providers: {
      custom: { baseUrl: "http://x", headers: { Accept: "application/json" } },
    },
  });
  assert.equal(redacted.version, 1);
  assert.deepEqual(redacted.providers.custom, { baseUrl: "http://x", headers: { Accept: "application/json" } });
});

test("merge keeps stored literal apiKey when incoming omits it", () => {
  const merged = mergeStoredLiteralApiKeys(
    { custom: { baseUrl: "http://new" } },
    { custom: { baseUrl: "http://old", apiKey: "sk-old" } },
  );
  assert.deepEqual(merged.custom, { baseUrl: "http://new", apiKey: "sk-old" });
});

test("merge replaces apiKey when incoming provides one, including empty to clear", () => {
  const existing = { custom: { apiKey: "sk-old" } };
  assert.equal(mergeStoredLiteralApiKeys({ custom: { apiKey: "sk-new" } }, existing).custom.apiKey, "sk-new");
  assert.equal(mergeStoredLiteralApiKeys({ custom: { apiKey: "" } }, existing).custom.apiKey, "");
});

test("merge does not resurrect references or unrelated providers", () => {
  const merged = mergeStoredLiteralApiKeys(
    { newp: { apiKey: "sk-x" } },
    { oldp: { apiKey: "sk-gone" }, refp: { apiKey: "!cmd" } },
  );
  assert.deepEqual(Object.keys(merged), ["newp"]);
  assert.equal(merged.newp.apiKey, "sk-x");
});
