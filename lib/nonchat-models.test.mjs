import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { listNonChatModels } = await jiti.import("./nonchat-models.ts");
const { resultImageFileName } = await jiti.import("./result-image.ts");
const { groupByProvider } = await jiti.import("../components/NonChatModelsDetail.tsx");

function runtime(catalog, available) {
  return {
    getModelsOfType: (type) => catalog[type] ?? [],
    getAvailableOfType: async (type) => available[type] ?? [],
  };
}

test("lists classifier and image models with sign-in state, signed-in providers first", async () => {
  const jev = { provider: "typesafe", id: "jev-latest", name: "Jev", cost: { input: 0, output: 0 } };
  const flux = { provider: "openrouter", id: "black-forest-labs/flux.2-pro", name: "FLUX.2 Pro", cost: { input: 0, output: 0 }, output: ["image"] };
  const gemini = { provider: "openrouter", id: "google/gemini-2.5-flash-image", name: "Gemini Image", cost: { input: 0.3, output: 30 }, output: ["text", "image"] };
  const other = { provider: "acme", id: "pix", name: "Pix", cost: { input: 1, output: 2 }, output: ["image"] };

  const models = await listNonChatModels(runtime(
    { classifier: [jev], image: [other, flux, gemini] },
    { image: [flux, gemini] },
  ));

  assert.deepEqual(models.classifier, [{ provider: "typesafe", id: "jev-latest", name: "Jev", available: false }]);
  assert.deepEqual(models.image.map((m) => [m.provider, m.name, m.available]), [
    ["openrouter", "FLUX.2 Pro", true],
    ["openrouter", "Gemini Image", true],
    ["acme", "Pix", false],
  ]);
  assert.deepEqual(models.image[1].cost, { input: 0.3, output: 30 });
  assert.equal(models.image[1].textOutput, true);
  assert.equal("cost" in models.image[0], false, "a catalog without a price shows none");
});

test("groups by provider, marking a provider signed in when its models are", () => {
  const groups = groupByProvider([
    { provider: "openrouter", id: "a", name: "A", available: true },
    { provider: "openrouter", id: "b", name: "B", available: true },
    { provider: "acme", id: "c", name: "C", available: false },
  ]);
  assert.deepEqual(groups.map((g) => [g.provider, g.available, g.models.length]), [
    ["openrouter", true, 2],
    ["acme", false, 1],
  ]);
});

test("names a saved tool-result image after its media type", () => {
  assert.equal(resultImageFileName("image/jpeg", 0), "image-1.jpg");
  assert.equal(resultImageFileName("IMAGE/WEBP", 2), "image-3.webp");
  assert.equal(resultImageFileName(undefined, 0), "image-1.png");
});
