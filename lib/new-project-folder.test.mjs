import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { resolveNewProjectFolder } = await jiti.import("./new-project-folder.ts");

const HOME = "/home/tester";

test("a bare name and relative paths land inside the home directory", () => {
  assert.deepEqual(resolveNewProjectFolder("my-project", HOME), { dir: "/home/tester/my-project" });
  assert.deepEqual(resolveNewProjectFolder("  spaced-name  ", HOME), { dir: "/home/tester/spaced-name" });
  assert.deepEqual(resolveNewProjectFolder("work/nested/proj", HOME), { dir: "/home/tester/work/nested/proj" });
});

test("~/ and absolute paths inside home are honored", () => {
  assert.deepEqual(resolveNewProjectFolder("~/projects/x", HOME), { dir: "/home/tester/projects/x" });
  assert.deepEqual(resolveNewProjectFolder("/home/tester/deep/dir", HOME), { dir: "/home/tester/deep/dir" });
});

test("candidates outside home are rejected", () => {
  assert.ok(resolveNewProjectFolder("/mnt/c/Users/x/proj", HOME).error);
  assert.ok(resolveNewProjectFolder("/etc/tmp", HOME).error);
  // Traversal that resolves back out of home must not slip through.
  assert.ok(resolveNewProjectFolder("foo/../../outside", HOME).error);
});

test("home itself and empty input are rejected", () => {
  assert.ok(resolveNewProjectFolder("~", HOME).error);
  assert.ok(resolveNewProjectFolder("/home/tester", HOME).error);
  assert.ok(resolveNewProjectFolder("   ", HOME).error);
  assert.ok(resolveNewProjectFolder("", HOME).error);
});
