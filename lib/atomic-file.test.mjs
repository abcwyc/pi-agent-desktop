import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { writePrivateFileAtomicSync } = await import("./atomic-file.ts");

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-atomic-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("atomically replaces a file with restrictive permissions", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "models.json");
  fs.writeFileSync(destination, "old", { mode: 0o644 });

  writePrivateFileAtomicSync(destination, "new");

  assert.equal(fs.readFileSync(destination, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(root), ["models.json"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  }
});

test("keeps the destination and removes the temporary file when replacement fails", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "models.json");
  fs.mkdirSync(destination);

  assert.throws(() => writePrivateFileAtomicSync(destination, "new"));
  assert.equal(fs.statSync(destination).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(root), ["models.json"]);
});

test("replaceFileAtomicSync keeps the permission bits of the file it replaces", { skip: process.platform === "win32" && "POSIX modes" }, async (t) => {
  const { replaceFileAtomicSync } = await import("./atomic-file.ts");
  const root = createTempRoot(t);
  const destination = path.join(root, "session.jsonl");
  fs.writeFileSync(destination, "old\n");
  fs.chmodSync(destination, 0o640);

  replaceFileAtomicSync(destination, "new\n");

  assert.equal(fs.readFileSync(destination, "utf8"), "new\n");
  assert.equal(fs.statSync(destination).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(root), ["session.jsonl"]);
});

test("replaceFileAtomicSync applies an explicit mode", { skip: process.platform === "win32" && "POSIX modes" }, async (t) => {
  const { replaceFileAtomicSync } = await import("./atomic-file.ts");
  const root = createTempRoot(t);
  const destination = path.join(root, "settings.json");
  fs.writeFileSync(destination, "{}", { mode: 0o644 });

  replaceFileAtomicSync(destination, "{\"a\":1}", { mode: 0o600 });

  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
});

test("replaceFileAtomicSync replaces a symlinked file at its target and keeps the link", async (t) => {
  const { fileSymlinkSkip } = await import("../scripts/test-platform.mjs");
  if (fileSymlinkSkip) return t.skip(fileSymlinkSkip);
  const { replaceFileAtomicSync } = await import("./atomic-file.ts");
  const root = createTempRoot(t);
  fs.mkdirSync(path.join(root, "dotfiles"));
  const target = path.join(root, "dotfiles", "settings.json");
  const link = path.join(root, "settings.json");
  fs.writeFileSync(target, "old");
  fs.symlinkSync(target, link, "file");

  replaceFileAtomicSync(link, "new");

  assert.ok(fs.lstatSync(link).isSymbolicLink(), "a dotfiles link stays a link");
  assert.equal(fs.readFileSync(target, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(path.join(root, "dotfiles")), ["settings.json"]);
});

test("replaceFileAtomicSync leaves the old text when the write fails", async (t) => {
  const { replaceFileAtomicSync } = await import("./atomic-file.ts");
  const root = createTempRoot(t);
  const destination = path.join(root, "SKILL.md");
  fs.writeFileSync(destination, "old");

  // A value writeFileSync rejects stands in for ENOSPC: the replacement fails before the rename.
  assert.throws(() => replaceFileAtomicSync(destination, Symbol("unwritable")));

  assert.equal(fs.readFileSync(destination, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(root), ["SKILL.md"]);
});

test("user files rewritten in place go through replaceFileAtomicSync", () => {
  // A truncating write of these loses a transcript, every setting, a skill or every
  // stored API key when the process dies or the disk fills mid-write.
  const sites = {
    "../app/api/sessions/[id]/route.ts": /writeFileSync\(childPath/,
    "../app/api/sessions/[id]/continue-in-project/route.ts": /writeFileSync\(file,/,
    "./global-settings-file.ts": /writeFileSync\(settingsPath, JSON\.stringify/,
    "../app/api/skills/route.ts": /writeFileSync\(filePath, updated/,
    "./provider-credential-store.ts": /writeFileSync\(authPath, JSON\.stringify/,
  };
  for (const [file, inPlace] of Object.entries(sites)) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, inPlace, file);
    assert.match(source, /replaceFileAtomicSync\(/, file);
  }
});
