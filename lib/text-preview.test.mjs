import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { TEXT_PREVIEW_MAX_BYTES } = await jiti.import("./file-types.ts");
const { readTextPreviewChunk } = await jiti.import("./text-preview.ts");

test("reads large text in contiguous UTF-8 chunks", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "large.txt");
  const content = "a".repeat(TEXT_PREVIEW_MAX_BYTES - 1) + "😀tail";
  writeFileSync(filePath, content);
  const size = statSync(filePath).size;

  const first = readTextPreviewChunk(filePath, size, 0);
  const second = readTextPreviewChunk(filePath, size, first.nextOffset);

  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, TEXT_PREVIEW_MAX_BYTES - 1);
  assert.equal(second.truncated, false);
  assert.equal(first.content + second.content, content);
  assert.equal(second.nextOffset, size);
});

test("invalid UTF-8 cannot stall pagination", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "binary.txt");
  writeFileSync(filePath, Buffer.alloc(TEXT_PREVIEW_MAX_BYTES + 1, 0x80));

  const chunk = readTextPreviewChunk(filePath, TEXT_PREVIEW_MAX_BYTES + 1, 0);

  assert.equal(chunk.nextOffset, TEXT_PREVIEW_MAX_BYTES);
  assert.equal(chunk.truncated, true);
});

function writeTemp(t, name, content) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, name);
  writeFileSync(filePath, content);
  return { filePath, size: statSync(filePath).size };
}

test("a NUL in the first 8000 bytes marks the file binary, with no decoded bytes", (t) => {
  // A ZIP's local file header has NULs right after its "PK\x03\x04" signature.
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]), Buffer.alloc(64, 0x41)]);
  const { filePath, size } = writeTemp(t, "archive.zip", zip);

  assert.deepEqual(readTextPreviewChunk(filePath, size, 0), {
    content: "",
    nextOffset: 0,
    truncated: false,
    binary: true,
  });
});

test("text without NULs stays text: unknown extensions, invalid UTF-8, a late NUL", (t) => {
  const plain = writeTemp(t, "notes.unknownext", "plain text\n");
  assert.equal(readTextPreviewChunk(plain.filePath, plain.size, 0).binary, false);
  assert.equal(readTextPreviewChunk(plain.filePath, plain.size, 0).content, "plain text\n");

  // Latin-1 text is invalid UTF-8 but not binary: it keeps its replacement characters.
  const latin1 = writeTemp(t, "legacy.txt", Buffer.from("caf\xe9\n", "latin1"));
  assert.equal(readTextPreviewChunk(latin1.filePath, latin1.size, 0).binary, false);

  // Like git, only the first 8000 bytes are looked at.
  const late = writeTemp(t, "late.log", Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0])]));
  assert.equal(readTextPreviewChunk(late.filePath, late.size, 0).binary, false);

  const empty = writeTemp(t, "empty.txt", "");
  assert.equal(readTextPreviewChunk(empty.filePath, empty.size, 0).binary, false);
});

test("UTF-16 with a byte order mark keeps its text view", (t) => {
  const le = writeTemp(t, "utf16le.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")]));
  assert.equal(readTextPreviewChunk(le.filePath, le.size, 0).binary, false);
  const be = writeTemp(t, "utf16be.txt", Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]));
  assert.equal(readTextPreviewChunk(be.filePath, be.size, 0).binary, false);
});

test("Load more continues a file shown as text even past a NUL", (t) => {
  const content = Buffer.concat([Buffer.alloc(TEXT_PREVIEW_MAX_BYTES, 0x61), Buffer.from([0, 0x62])]);
  const { filePath, size } = writeTemp(t, "mixed.txt", content);

  const first = readTextPreviewChunk(filePath, size, 0);
  const second = readTextPreviewChunk(filePath, size, first.nextOffset);

  assert.equal(first.binary, false);
  assert.equal(second.binary, false);
  assert.equal(second.content, "\0b");
});
