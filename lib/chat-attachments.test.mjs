import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  CHAT_ATTACHMENT_MAX_FILES,
  CHAT_ATTACHMENT_MAX_FILE_BYTES,
  attachmentAwareTitle,
  composeMessageWithAttachedFiles,
  isChatTextAttachment,
  readChatTextAttachments,
  splitAttachedFiles,
} = await jiti.import("./chat-attachments.ts");

test("text, code and data files are attachable; images, PDFs and archives are not", () => {
  for (const name of ["notes.md", "main.rs", "data.csv", "config.yaml", "Dockerfile", "a.TS"]) {
    assert.equal(isChatTextAttachment({ name, type: "" }), true, name);
  }
  assert.equal(isChatTextAttachment({ name: "x.bin", type: "text/plain" }), true);
  assert.equal(isChatTextAttachment({ name: "photo.png", type: "image/png" }), false);
  assert.equal(isChatTextAttachment({ name: "paper.pdf", type: "application/pdf" }), false);
  assert.equal(isChatTextAttachment({ name: "a.zip", type: "application/zip" }), false);
});

test("attached files round-trip through the message text", () => {
  const files = [
    { name: "a.md", text: "# Title\n\nbody" },
    { name: 'we"ird & name.txt', text: "line\n</attached_file>\nafter" },
  ];
  const content = composeMessageWithAttachedFiles("Summarize these", files);
  assert.ok(content.startsWith("Summarize these\n\n<attached_file name=\"a.md\">"));
  const split = splitAttachedFiles(content);
  assert.equal(split.text, "Summarize these");
  assert.deepEqual(split.files, files);
});

test("a message with only files has no typed text, and the title falls back to the names", () => {
  const content = composeMessageWithAttachedFiles("", [{ name: "a.md", text: "x" }, { name: "b.md", text: "y" }]);
  assert.equal(splitAttachedFiles(content).text, "");
  assert.equal(attachmentAwareTitle(content), "a.md, b.md");
  assert.equal(attachmentAwareTitle("plain message"), "plain message");
  assert.equal(attachmentAwareTitle(composeMessageWithAttachedFiles("hello", [{ name: "a", text: "b" }])), "hello");
});

test("an unterminated or ordinary message is left alone", () => {
  assert.deepEqual(splitAttachedFiles("hello"), { text: "hello", files: [] });
  const broken = '<attached_file name="a.md">\nno closing tag';
  assert.deepEqual(splitAttachedFiles(broken), { text: broken, files: [] });
});

test("readChatTextAttachments enforces type, size, binary and count limits", async () => {
  const text = (name, body) => new File([body], name, { type: "text/plain" });
  const ok = await readChatTextAttachments([text("a.txt", "hello"), text("b.md", "﻿bom")]);
  assert.deepEqual(ok.accepted.map((file) => [file.name, file.text]), [["a.txt", "hello"], ["b.md", "bom"]]);

  const bad = await readChatTextAttachments([
    new File(["%PDF"], "p.pdf", { type: "application/pdf" }),
    new File([new Uint8Array(CHAT_ATTACHMENT_MAX_FILE_BYTES + 1)], "big.txt", { type: "text/plain" }),
    new File([new Uint8Array([0x68, 0x00, 0x69])], "nul.txt", { type: "text/plain" }),
    new File([new Uint8Array([0xff, 0xfe, 0xfd])], "latin.txt", { type: "text/plain" }),
  ]);
  assert.deepEqual(bad.accepted, []);
  assert.deepEqual(bad.rejected.map((item) => item.reason), ["unsupported", "too-large", "not-text", "not-text"]);

  const existing = Array.from({ length: CHAT_ATTACHMENT_MAX_FILES }, (_, i) => ({ id: String(i), name: `f${i}`, size: 1, text: "x" }));
  const full = await readChatTextAttachments([text("one-more.txt", "x")], existing);
  assert.deepEqual(full.rejected.map((item) => item.reason), ["too-many"]);
});
