import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");

// Real paths: the temp folder is a link on macOS, and allowed roots compare resolved paths.
const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "pi-web-cwd-status-")));
const allowed = path.join(root, "allowed");
const project = path.join(allowed, "project");
const deleted = path.join(allowed, "deleted");
const file = path.join(allowed, "file.txt");
const escape = path.join(allowed, "escape");
const outside = path.join(root, "outside");
await mkdir(project, { recursive: true });
await mkdir(outside, { recursive: true });
await writeFile(file, "not a folder");
await symlink(outside, escape);
allowFileRoot(allowed);
after(() => rm(root, { recursive: true, force: true }));

async function status(cwd) {
  const response = await GET(new Request(`http://localhost/api/cwd/status?cwd=${encodeURIComponent(cwd)}`));
  return { status: response.status, body: await response.json() };
}

test("reports an existing workspace as available", async () => {
  assert.deepEqual(await status(project), { status: 200, body: { cwd: project, availability: "available" } });
});

test("reports a deleted workspace inside the allowed roots as missing", async () => {
  assert.deepEqual(await status(deleted), { status: 200, body: { cwd: deleted, availability: "missing" } });
  // A parent component that became a file means the folder is gone too.
  assert.equal((await status(path.join(file, "child"))).body.availability, "missing");
});

test("keeps a file at the workspace path distinct from a missing folder", async () => {
  assert.equal((await status(file)).body.availability, "not-directory");
});

test("refuses paths outside the roots without revealing whether they exist", async () => {
  assert.deepEqual(await status(outside), { status: 403, body: { error: "Access denied" } });
  assert.deepEqual(await status(path.join(root, "never-created")), { status: 403, body: { error: "Access denied" } });
  // `..` and links that leave the roots are refused like any other outside path.
  assert.equal((await status(`${allowed}/../outside`)).status, 403);
  assert.equal((await status(escape)).status, 403);
});

test("requires an absolute cwd", async () => {
  assert.equal((await status("relative/project")).status, 400);
  const response = await GET(new Request("http://localhost/api/cwd/status"));
  assert.equal(response.status, 400);
});
