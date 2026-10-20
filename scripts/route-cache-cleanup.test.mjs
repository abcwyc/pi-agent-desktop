import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// #149: an overwrite install leaves the previous version's `server/route-cache`
// in place and Next reads it before the new build's prerendered pages.
async function stageServer(t, { buildId, marker, cached }) {
  const dir = await mkdtemp(join(os.tmpdir(), "pi-route-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(join(rootDir, "desktop", "server-launcher.cjs"), join(dir, "desktop-server.cjs"));
  // Stand-in for the standalone entrypoint: leave straight away.
  await writeFile(join(dir, "server.js"), "process.exit(0);\n");
  const next = join(dir, ".next-desktop");
  await mkdir(join(next, "server", "route-cache", "APP_PAGE"), { recursive: true });
  await writeFile(join(next, "server", "route-cache", "APP_PAGE", "index.html"), cached);
  if (buildId !== null) await writeFile(join(next, "BUILD_ID"), buildId);
  if (marker !== undefined) await writeFile(join(next, ".route-cache-build-id"), marker);
  return dir;
}

function launch(dir) {
  const result = spawnSync(process.execPath, [join(dir, "desktop-server.cjs")], {
    env: { ...process.env, PI_WEB_PARENT_PID: String(process.pid) },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stderr;
}

const cachedPage = (dir) => join(dir, ".next-desktop", "server", "route-cache", "APP_PAGE", "index.html");
const markerOf = (dir) => readFile(join(dir, ".next-desktop", ".route-cache-build-id"), "utf8");

test("a new build id drops the previous build's route cache", async (t) => {
  const dir = await stageServer(t, { buildId: "new-build", marker: "old-build", cached: "old ui" });
  launch(dir);
  assert.equal(existsSync(join(dir, ".next-desktop", "server", "route-cache")), false);
  assert.equal(await markerOf(dir), "new-build");
});

test("an install without a marker is treated as stale", async (t) => {
  const dir = await stageServer(t, { buildId: "new-build", cached: "old ui" });
  launch(dir);
  assert.equal(existsSync(join(dir, ".next-desktop", "server", "route-cache")), false);
  assert.equal(await markerOf(dir), "new-build");
});

test("the same build id keeps the route cache", async (t) => {
  const dir = await stageServer(t, { buildId: "same-build", marker: "same-build", cached: "current ui" });
  launch(dir);
  assert.equal(await readFile(cachedPage(dir), "utf8"), "current ui");
});

test("a missing BUILD_ID leaves the cache alone and still starts the server", async (t) => {
  const dir = await stageServer(t, { buildId: null, cached: "unknown ui" });
  launch(dir);
  assert.equal(await readFile(cachedPage(dir), "utf8"), "unknown ui");
});

test("the Windows installer hook clears the route cache before writing files", async () => {
  const hooks = await readFile(join(rootDir, "src-tauri", "installer-hooks.nsh"), "utf8");
  assert.match(
    hooks,
    /RMDir \/r "\$INSTDIR\\resources\\server\\\.next-desktop\\server\\route-cache"/,
  );
});
