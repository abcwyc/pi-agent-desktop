import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildComposerHistory } = await jiti.import("./composer-history.ts");

const png = "aGVsbG8=";
const nested = { type: "image", source: { type: "base64", media_type: "image/png", data: png } };
const legacy = { type: "image", data: png, mimeType: "image/png" };
const note = "[Image: original 2100x1180, displayed at 2000x1124. Multiply coordinates by 1.05 to map to original image.]";
const user = (content, timestamp = 0) => ({ role: "user", content, timestamp });

test("history keeps each prompt's images and drops SDK resize notes", () => {
  const history = buildComposerHistory([
    user([{ type: "text", text: "first" }], 1),
    { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 },
    user([{ type: "text", text: `describe\n\n${note}` }, nested], 3),
  ]);
  assert.deepEqual(history, [
    { text: "first", images: [] },
    { text: "describe", images: [{ data: png, mimeType: "image/png" }] },
  ]);
});

test("legacy flat images and image-only prompts are restorable", () => {
  const other = { ...legacy, data: "b3RoZXI=" };
  const history = buildComposerHistory([user([legacy], 1), user([{ type: "text", text: `\n\n${note}` }, other], 2)]);
  assert.deepEqual(history, [
    { text: "", images: [{ data: png, mimeType: "image/png" }] },
    { text: "", images: [{ data: "b3RoZXI=", mimeType: "image/png" }] },
  ]);
});

test("newest last, duplicates collapse, limit applies, and text-only notes stay untouched", () => {
  const history = buildComposerHistory([
    user("same", 1), user("same", 2), user([{ type: "text", text: note }], 3),
  ], 50);
  assert.deepEqual(history, [
    { text: "same", images: [] },
    { text: note, images: [] },
  ]);
  assert.equal(buildComposerHistory([user("a", 1), user("b", 2)], 1).length, 1);
});

test("same-text prompts with shared image headers retain distinct payloads", () => {
  const prefix = "A".repeat(64);
  const first = { ...legacy, data: prefix + "AAAA" };
  const second = { ...legacy, data: prefix + "BBBB" };
  const prompt = (image) => user([{ type: "text", text: "describe" }, image]);
  const history = buildComposerHistory([prompt(first), prompt(second), prompt(first)]);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((entry) => entry.images[0].data), [second.data, first.data]);
});

test("all images, their order and MIME types participate in deduplication", () => {
  const second = { ...legacy, data: "b3RoZXI=" };
  const prompt = (images) => user([{ type: "text", text: "compare" }, ...images]);
  const history = buildComposerHistory([
    prompt([legacy, legacy]),
    prompt([legacy, second]),
    prompt([second, legacy]),
    prompt([legacy, { ...second, mimeType: "image/jpeg" }]),
    prompt([legacy, second]),
  ]);
  assert.equal(history.length, 4);
  assert.deepEqual(history.at(-1).images, [
    { data: png, mimeType: "image/png" },
    { data: second.data, mimeType: "image/png" },
  ]);
});

test("image-only prompts with shared headers remain distinct", () => {
  const prefix = "A".repeat(64);
  const history = buildComposerHistory([
    user([{ ...legacy, data: prefix + "AAAA" }]),
    user([{ ...legacy, data: prefix + "BBBB" }]),
  ]);
  assert.equal(history.length, 2);
  assert.ok(history.every((entry) => entry.text === ""));
});

test("chat attachment markup remains in the entry so the composer can rebuild chips", () => {
  const markup = '<pi-web-attachments>[{"name":"a.txt","text":"x"}]</pi-web-attachments>';
  const [entry] = buildComposerHistory([user(`question\n\n${markup}`, 1)]);
  assert.match(entry.text, /^question/);
  assert.match(entry.text, /pi-web-attachments/);
});
