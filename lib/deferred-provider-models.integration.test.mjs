import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { findDeferredModel, rememberProviderModels, withDeferredProviderModels } = await jiti.import("./deferred-provider-models.ts");
const { writeModelsConfig } = await jiti.import("./models-config-store.ts");

const providerConfig = {
  baseUrl: "http://127.0.0.1:9/v1",
  apiKey: "dummy",
  api: "openai-completions",
  models: [{
    id: "test-model", name: "Test Model", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000, maxTokens: 100,
  }],
};

beforeEach(() => {
  globalThis.__piWebProviderModelCatalog = undefined;
});

for (const operation of ["rename", "delete"]) {
  test(`a models.json provider does not reappear after ${operation}, while deferred extensions remain available`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-provider-models-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const modelsPath = join(root, "models.json");
    const createRuntime = () => ModelRuntime.create({
      authPath: join(root, "auth.json"), modelsPath,
      modelsStorePath: join(root, "models-store.json"),
    });
    writeModelsConfig({ providers: { "old-provider": providerConfig } }, modelsPath);
    const first = await createRuntime();
    first.registerProvider("deferred-extension", providerConfig);
    first.registerVirtualModel({
      provider: "virtual-extension", id: "auto", name: "Auto",
      route: () => ({ model: first.getModel("old-provider", "test-model"), thinkingLevel: "off" }),
    });
    await first.refresh({ allowNetwork: false });
    assert.ok(!first.getRegisteredProviderIds().includes("virtual-extension"));
    assert.ok((await first.getAvailable()).some((model) => model.provider === "old-provider"));
    await rememberProviderModels(first);

    writeModelsConfig({
      providers: operation === "rename" ? { "new-provider": providerConfig } : {},
    }, modelsPath);
    const later = await createRuntime();
    assert.equal(later.getProvider("old-provider"), undefined);
    await rememberProviderModels(later);
    const available = await withDeferredProviderModels(later).getAvailable();
    assert.ok(!available.some((model) => model.provider === "old-provider"));
    assert.equal(findDeferredModel(later, "old-provider", "test-model"), undefined);
    assert.ok(available.some((model) => model.provider === "deferred-extension"));
    assert.ok(available.some((model) => model.provider === "virtual-extension"));
    assert.equal(available.some((model) => model.provider === "new-provider"), operation === "rename");

    // A still-open session may report its pre-save runtime after the edit.
    await rememberProviderModels(first);
    assert.ok(!(await withDeferredProviderModels(later).getAvailable())
      .some((model) => model.provider === "old-provider"));
  });
}
