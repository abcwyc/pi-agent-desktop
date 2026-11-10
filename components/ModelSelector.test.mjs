import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ModelSelector.tsx", import.meta.url), "utf8");

test("does not autofocus the model filter on mobile", () => {
  // Autofocus would open the on-screen keyboard as soon as the picker opens.
  assert.match(source, /aria-label=\{t\("chat\.filterModels"\)\}[\s\S]*?autoFocus=\{!isMobile\}/);
  assert.doesNotMatch(source, /^\s*autoFocus\s*$/m);
});

test("groups show the provider's display name and the filter matches it, its id and provider/model (M4)", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
  const { filterModelOptions } = await jiti.import("./ModelSelector.tsx");
  const options = [
    { provider: "zai-coding-cn", providerName: "Z.AI Coding CN", modelId: "glm-5.3", name: "GLM-5.3" },
    { provider: "deepseek", providerName: "DeepSeek", modelId: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { provider: "aliyun-bailian", modelId: "qwen3.7-plus", name: "Qwen 3.7 Plus" },
  ];
  const ids = (query) => filterModelOptions(options, query).map((option) => option.modelId);
  assert.deepEqual(ids("z.ai coding"), ["glm-5.3"]);
  assert.deepEqual(ids("zai-coding-cn"), ["glm-5.3"]);
  assert.deepEqual(ids("aliyun-bailian/qwen"), ["qwen3.7-plus"]);
  assert.deepEqual(ids("deepseek"), ["deepseek-v4-pro"]);
  assert.match(source, /label: option\.providerName \|\| option\.provider/);
  assert.match(source, /\{group\.label\}/);
  assert.doesNotMatch(source, /textTransform: "uppercase"/);
});
