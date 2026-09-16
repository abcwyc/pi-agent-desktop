import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { resolveNewProjectFolder } = await jiti.import("./new-project-folder.ts");

const HOME = mkdtempSync(path.join(tmpdir(), "pi-project-home-"));
process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));

test("a bare name and relative paths land inside the home directory", () => {
  assert.deepEqual(resolveNewProjectFolder("my-project", HOME), { dir: `${HOME}/my-project` });
  assert.deepEqual(resolveNewProjectFolder("  spaced-name  ", HOME), { dir: `${HOME}/spaced-name` });
  assert.deepEqual(resolveNewProjectFolder("work/nested/proj", HOME), { dir: `${HOME}/work/nested/proj` });
});

test("~/ and absolute paths inside home are honored", () => {
  assert.deepEqual(resolveNewProjectFolder("~/projects/x", HOME), { dir: `${HOME}/projects/x` });
  assert.deepEqual(resolveNewProjectFolder(`${HOME}/deep/dir`, HOME), { dir: `${HOME}/deep/dir` });
});

test("candidates outside home are rejected", () => {
  assert.ok(resolveNewProjectFolder("/mnt/c/Users/x/proj", HOME).error);
  assert.ok(resolveNewProjectFolder("/etc/tmp", HOME).error);
  // Traversal that resolves back out of home must not slip through.
  assert.ok(resolveNewProjectFolder("foo/../../outside", HOME).error);
});

test("rejects a parent symlink escaping home", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "pi-project-outside-"));
  const link = path.join(HOME, "external");
  symlinkSync(outside, link, "dir");
  try {
    assert.ok(resolveNewProjectFolder("external/project", HOME).error);
  } finally {
    rmSync(link);
    rmSync(outside, { recursive: true, force: true });
  }
});

test("rejects a target symlink escaping home", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "pi-project-outside-"));
  const link = path.join(HOME, "existing-link");
  symlinkSync(outside, link, "dir");
  try {
    assert.ok(resolveNewProjectFolder("existing-link", HOME).error);
  } finally {
    rmSync(link);
    rmSync(outside, { recursive: true, force: true });
  }
});

test("home itself and empty input are rejected", () => {
  assert.ok(resolveNewProjectFolder("~", HOME).error);
  assert.ok(resolveNewProjectFolder(HOME, HOME).error);
  assert.ok(resolveNewProjectFolder("   ", HOME).error);
  assert.ok(resolveNewProjectFolder("", HOME).error);
});
