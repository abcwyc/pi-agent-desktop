import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { getModelIconProvider, ModelIcon } = await jiti.import("./ProviderIcon.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");

test("relay models keep their own brand rather than the gateway logo", () => {
  for (const [id, brand] of [
    ["anthropic/claude-sonnet-4-6", "anthropic"], ["gpt-5.4", "openai"],
    ["openai/o3-mini", "openai"], ["google/gemini-3-pro", "google"],
    ["deepseek/deepseek-v4-flash", "deepseek"], ["Qwen3.5-Plus", "qwen"],
    ["kimi-k2.5", "kimi-coding"], ["MiniMax-M2.5", "minimax"],
    ["grok-4", "xai"], ["codestral-latest", "mistral"], ["glm-5", "zhipu"],
    ["mimo-v2-flash", "xiaomi"], ["command-r-plus", "cohere"],
  ]) assert.equal(getModelIconProvider("my-relay", id), brand, id);
});

test("id wins over display name, with safe name and provider fallbacks", () => {
  assert.equal(getModelIconProvider("relay", "gpt-5", "Claude"), "openai");
  assert.equal(getModelIconProvider("relay", "custom-id", "Claude Sonnet"), "anthropic");
  assert.equal(getModelIconProvider("OpenRouter", "unknown-model"), "openrouter");
  assert.equal(getModelIconProvider("custom", "mygptish-commandcode"), "custom");
});

test("icons use local assets, are decorative, and unknown brands retain a fallback", () => {
  const icon = renderToStaticMarkup(React.createElement(ModelIcon, { provider: "relay", modelId: "claude-opus-4", size: 16 }));
  assert.match(icon, /href="\/provider-icons.svg#anthropic"/);
  assert.match(icon, /aria-hidden="true"/);
  assert.doesNotMatch(icon, /https?:/);
  const unknown = renderToStaticMarkup(React.createElement(ModelIcon, { provider: "my-relay", modelId: "custom" }));
  assert.match(unknown, />MR<\/span>/);
});
