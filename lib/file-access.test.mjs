import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Loaded through jiti so the module's own extensionless imports resolve the way
// the app resolves them (tsconfig moduleResolution: "bundler"); bare
// `import("./path-security.ts")` only works while that file has no imports.
async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./path-security.ts");
}

test("rejects an existing path that escapes an allowed root through a symlink", async (t) => {
  const { isExistingPathWithinRoots, isPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-access-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  const link = path.join(allowed, "link");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const target = path.join(link, "secret.txt");
  const roots = new Set([allowed]);

  assert.equal(isPathWithinRoots(target, roots), true);
  assert.equal(isExistingPathWithinRoots(target, roots), false);
});

test("allowed roots reuse a stale session catalogue instead of forcing a rebuild", async (t) => {
  // An empty agent dir: a forced rebuild would find no sessions at all, so the
  // stale entry below is only present when the previous scan is reused.
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-allowed-roots-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(agentDir, { recursive: true, force: true });
    globalThis.__piAllowedRootsCache = undefined;
    globalThis.__piSessionListCache = undefined;
  });
  const { createJiti } = await import("jiti");
  const { getAllowedFileRoots } = await createJiti(import.meta.url).import("./file-access.ts");
  const staleCwd = path.join(agentDir, "stale-project");
  globalThis.__piAllowedRootsCache = undefined;
  globalThis.__piSessionListGeneration = 7;
  globalThis.__piSessionListCache = { data: [{ id: "s1", cwd: staleCwd }], ts: 0, generation: 6 };

  const roots = await getAllowedFileRoots();
  assert.equal(roots.has(staleCwd.replace(/\\/g, "/")), true);
});

test("rejects a `..` that climbs out beside a link's target", async (t) => {
  const { hasParentDirectorySegment, isExistingPathWithinRoots } = await loadSubject();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-access-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(path.join(outside, "linked"), { recursive: true });
  fs.symlinkSync(path.join(outside, "linked"), path.join(allowed, "link"), process.platform === "win32" ? "junction" : "dir");
  const roots = new Set([allowed]);

  // realpathSync reads `allowed/link/..` as `allowed`; opening it lists `outside`.
  const climb = `${allowed}${path.sep}link${path.sep}..`;
  assert.equal(isExistingPathWithinRoots(climb, roots), false);
  assert.equal(isExistingPathWithinRoots(path.join(allowed, "link"), new Set([allowed, outside])), true);

  assert.equal(hasParentDirectorySegment("/a/b/../c"), true);
  assert.equal(hasParentDirectorySegment("C:\\a\\..\\c"), true);
  assert.equal(hasParentDirectorySegment("/a/..b/c.."), false);
  if (process.platform !== "win32") assert.equal(hasParentDirectorySegment("/a/b\\..\\c"), false);
});
