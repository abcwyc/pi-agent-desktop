import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { moveModelEntry, modelDropIndex, savedModelIds, sortModelEntries } = await jiti.import("./models-config-helpers.ts");
const source = (await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

const config = () => ({ providers: { relay: { models: [{ id: "b-2" }, { id: "a-10" }, { id: "a-9" }] }, other: { models: [{ id: "x" }] } } });

test("moving a model reorders only its provider and carries its saved slot along (M5)", () => {
  const draft = config();
  const slots = savedModelIds(draft);
  const change = moveModelEntry(draft, slots, "relay", 0, 2);
  assert.deepEqual(change.config.providers.relay.models.map((model) => model.id), ["a-10", "a-9", "b-2"]);
  assert.deepEqual(change.order, [1, 2, 0]);
  assert.deepEqual(slots.get("relay"), ["a-10", "a-9", "b-2"]);
  assert.equal(change.config.providers.other, draft.providers.other);
  assert.equal(moveModelEntry(draft, slots, "relay", 0, 3), null, "outside the list");
  assert.equal(moveModelEntry(draft, slots, "relay", 1, 1), null, "nothing moves");
});

test("a drop before or after a row lands in the slot the line shows (M5)", () => {
  assert.equal(modelDropIndex(0, 2, true), 2);
  assert.equal(modelDropIndex(0, 2, false), 1);
  assert.equal(modelDropIndex(3, 1, false), 1);
  assert.equal(modelDropIndex(3, 1, true), 2);
});

test("A–Z sorts once by the id the fork's rows show, naturally (M5)", () => {
  const draft = config();
  const change = sortModelEntries(draft, savedModelIds(draft), "relay");
  assert.deepEqual(change.config.providers.relay.models.map((model) => model.id), ["a-9", "a-10", "b-2"]);
  assert.equal(sortModelEntries(change.config, savedModelIds(change.config), "relay"), null, "already sorted");
});

test("model rows drag, move with Alt+Up/Down and the footer offers A–Z (M5)", () => {
  assert.match(source, /aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/);
  assert.match(source, /moveModel\(pName, i, i \+ direction\);/);
  assert.match(source, /\{\.\.\.modelDragProps\(pName, i, m\.id\)\}/);
  assert.match(source, /className="models-sidebar-sort-button"[\s\S]*?onClick=\{\(\) => sortModels\(pName\)\}/);
  assert.doesNotMatch(source, /key=\{i\}\n\s*active=\{isModelSelected\}/, "rows keep their key across a reorder");
});
