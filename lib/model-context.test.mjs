import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { ContextWindowError, withContextWindowOverride, normalizeContextWindowOverrides } = await jiti.import("./model-context.ts");

test("editing a login model's context preserves provider credentials, other overrides and custom models", () => {
  const original = {
    providers: {
      "openai-codex": {
        headers: { "x-example": "keep" },
        modelOverrides: { "gpt-6-astra": { maxTokens: 128000 }, other: { contextWindow: 200000 } },
      },
      custom: { apiKey: "$EXAMPLE_KEY", models: [{ id: "custom-model", contextWindow: 1000000 }] },
    },
  };
  const draft = withContextWindowOverride(original, "openai-codex", "gpt-6-astra", "500000");
  const saved = normalizeContextWindowOverrides(draft);
  assert.deepEqual(saved.providers["openai-codex"], {
    headers: { "x-example": "keep" },
    modelOverrides: { "gpt-6-astra": { maxTokens: 128000, contextWindow: 500000 }, other: { contextWindow: 200000 } },
  });
  assert.deepEqual(saved.providers.custom, original.providers.custom);
  assert.equal(original.providers["openai-codex"].modelOverrides["gpt-6-astra"].contextWindow, undefined);
});

test("reset removes only the context override and cleans up containers it leaves empty", () => {
  const config = { providers: { login: { modelOverrides: {
    a: { contextWindow: 500000, maxTokens: 128000 }, b: { contextWindow: 500000 },
  } } } };
  const reset = withContextWindowOverride(config, "login", "a", undefined);
  assert.deepEqual(reset.providers.login.modelOverrides.a, { maxTokens: 128000 });
  assert.deepEqual(withContextWindowOverride({ providers: { login: { modelOverrides: { b: { contextWindow: 500000 } } } } }, "login", "b", undefined), { providers: {} });
  assert.deepEqual(withContextWindowOverride({ providers: {} }, "login", "missing", undefined), { providers: {} });
});

test("a typed context budget must be a whole number of tokens; a refusal names the model", () => {
  const typed = (value) => ({ providers: { login: { modelOverrides: { model: { contextWindow: value } } } } });
  for (const value of ["", " ", "500k", "500000junk", "1e6", "0x100", "1.5", "-1", "0", String(Number.MAX_SAFE_INTEGER + 2)]) {
    assert.throws(() => normalizeContextWindowOverrides(typed(value)), (error) => error instanceof ContextWindowError && error.model === "login/model", value);
  }
  assert.equal(normalizeContextWindowOverrides(typed(" 1050000 ")).providers.login.modelOverrides.model.contextWindow, 1050000);
});

test("a value already in models.json only has to pass pi's check, so it never blocks another save", () => {
  const config = { providers: {
    login: { modelOverrides: { a: { contextWindow: 400000.5 }, b: { contextWindow: "500000" } } },
    custom: { models: [{ id: "edited" }] },
  } };
  assert.deepEqual(normalizeContextWindowOverrides(config).providers.login.modelOverrides, { a: { contextWindow: 400000.5 }, b: { contextWindow: 500000 } });
  // pi refuses these too: writing one would break loading models.json.
  for (const value of [0, -1, null, true, {}]) {
    assert.throws(() => normalizeContextWindowOverrides({ providers: { login: { modelOverrides: { a: { contextWindow: value } } } } }), ContextWindowError);
  }
});
