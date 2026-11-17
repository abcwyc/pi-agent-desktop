import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { createPastedTextAttachment, CHAT_ATTACHMENT_MAX_FILE_BYTES: max } = await jiti.import("./chat-attachments.ts");

test("pasted attachments preserve text, count UTF-8 bytes and avoid existing names", () => {
  const text = "\uFEFF  中文\r\n\tcode\n";
  const first = createPastedTextAttachment(text, []).file;
  assert.equal(first.text, text);
  assert.equal(first.size, Buffer.byteLength(text));
  const second = createPastedTextAttachment(text, [first]).file;
  assert.equal(second.name, "Pasted text-2.txt");
  assert.notEqual(first.id, second.id);
});

test("pasted attachments enforce byte, total, count and NUL limits without truncation", () => {
  const first = createPastedTextAttachment("a".repeat(max), []).file;
  assert.equal(first.text.length, max);
  assert.equal(createPastedTextAttachment("中".repeat(Math.ceil(max / 3)), []).rejection.reason, "too-large");
  const second = createPastedTextAttachment("b".repeat(max), [first]).file;
  assert.equal(createPastedTextAttachment("x", [first, second]).rejection.reason, "total-too-large");
  assert.equal(createPastedTextAttachment("x", Array(5).fill(first)).rejection.reason, "too-many");
  assert.equal(createPastedTextAttachment("x\0y", []).rejection.reason, "not-text");
});
