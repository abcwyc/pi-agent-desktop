import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  applyBuiltinSettings,
  diffBuiltinSettings,
  findBuiltinMatch,
  hasBuiltinDiff,
  normalizeEndpoint,
} = await jiti.import("./builtin-model-match.ts");

const GLM = {
  id: "glm-5.3",
  name: "GLM-5.3",
  reasoning: true,
  thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
  compat: { supportsDeveloperRole: false, thinkingFormat: "qwen" },
};
const catalog = [
  { id: "plan-cn", name: "Plan CN", baseUrl: "https://plan.example.cn/v1", getModels: () => [GLM] },
  { id: "plan-cn-solo", name: "Plan CN (individual)", baseUrl: "https://plan.example.cn/v1", getModels: () => [GLM] },
  { id: "intl", name: "Intl", baseUrl: "https://plan.example.com/v1", getModels: () => [GLM] },
  { id: "per-model", name: "Per model", getModels: () => [{ id: "x", baseUrl: "https://gw.example.net/api" }] },
  { id: "broken", name: "Broken", baseUrl: "https://plan.example.cn/v1", getModels: () => { throw new Error("no"); } },
];

test("normalizeEndpoint ignores scheme, host case and trailing slashes", () => {
  assert.equal(normalizeEndpoint("https://Plan.Example.cn/v1/"), "plan.example.cn/v1");
  assert.equal(normalizeEndpoint("http://plan.example.cn/v1"), "plan.example.cn/v1");
  assert.equal(normalizeEndpoint("plan.example.cn/v1"), undefined);
  assert.equal(normalizeEndpoint(""), undefined);
});

test("findBuiltinMatch: every provider at the endpoint, the model from the first", () => {
  const result = findBuiltinMatch(catalog, "https://plan.example.cn/v1/", "glm-5.3");
  assert.deepEqual(result.providers.map((p) => p.id), ["plan-cn", "plan-cn-solo", "broken"]);
  assert.deepEqual(result.model.providers.map((p) => p.id), ["plan-cn", "plan-cn-solo"]);
  assert.deepEqual(result.model.thinkingLevelMap, GLM.thinkingLevelMap);
  assert.notEqual(result.model.thinkingLevelMap, GLM.thinkingLevelMap, "a copy, not the catalog's object");
});

test("findBuiltinMatch uses a model's own baseUrl and needs the exact endpoint", () => {
  assert.deepEqual(findBuiltinMatch(catalog, "https://gw.example.net/api", "x").providers.map((p) => p.id), ["per-model"]);
  assert.equal(findBuiltinMatch(catalog, "https://plan.example.cn/v2", "glm-5.3").providers.length, 0);
  assert.equal(findBuiltinMatch(catalog, "https://plan.example.cn/v1", "GLM-5.3").model, null);
});

test("diffBuiltinSettings names what differs; applyBuiltinSettings writes it", () => {
  const builtin = findBuiltinMatch(catalog, "https://plan.example.cn/v1", "glm-5.3").model;
  const draft = { id: "glm-5.3", reasoning: true, compat: { supportsStrictMode: true } };
  const diff = diffBuiltinSettings(builtin, draft, { thinkingFormat: "qwen" });
  assert.deepEqual(diff, { reasoning: false, thinkingLevelMap: true, compatKeys: ["supportsDeveloperRole"] });
  assert.equal(hasBuiltinDiff(diff), true);

  const applied = applyBuiltinSettings(draft, builtin);
  assert.deepEqual(applied.thinkingLevelMap, GLM.thinkingLevelMap);
  assert.deepEqual(applied.compat, { supportsStrictMode: true, supportsDeveloperRole: false, thinkingFormat: "qwen" });
  assert.equal(hasBuiltinDiff(diffBuiltinSettings(builtin, applied, applied.compat)), false);
});

test("applyBuiltinSettings drops reasoning and the map for a non-reasoning built-in model", () => {
  const builtin = { providers: [], reasoning: false };
  const applied = applyBuiltinSettings({ id: "m", reasoning: true, thinkingLevelMap: { low: null } }, builtin);
  assert.deepEqual(applied, { id: "m" });
});
