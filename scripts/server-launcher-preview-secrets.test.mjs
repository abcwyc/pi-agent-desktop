import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// Next skips proxy.ts (password gate, Host/Origin checks) for requests whose
// `x-prerender-revalidate` header equals the build's previewModeId, and the
// packaged app ships that id in `.next-desktop/prerender-manifest.json`. The
// launcher strips the header and rotates the secrets on every start.

const SHIPPED = {
  previewModeId: "0".repeat(32),
  previewModeSigningKey: "1".repeat(64),
  previewModeEncryptionKey: "2".repeat(64),
};

async function stageLauncher(t, serverSource, manifest) {
  const dir = await mkdtemp(join(os.tmpdir(), "pi-launcher-preview-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(join(rootDir, "desktop", "server-launcher.cjs"), join(dir, "desktop-server.cjs"));
  await writeFile(join(dir, "server.js"), serverSource);
  if (manifest !== undefined) {
    await mkdir(join(dir, ".next-desktop"), { recursive: true });
    await writeFile(
      join(dir, ".next-desktop", "prerender-manifest.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    );
  }
  return dir;
}

function runLauncher(dir) {
  return spawnSync(process.execPath, [join(dir, "desktop-server.cjs")], {
    env: { ...process.env, PI_WEB_PARENT_PID: String(process.pid) },
    encoding: "utf8",
    timeout: 15_000,
  });
}

const exitServer = `process.exit(0);\n`;

test("the launcher replaces the shipped preview secrets with fresh ones on every start", async (t) => {
  const manifest = { version: 4, routes: { "/": {} }, preview: { ...SHIPPED } };
  const dir = await stageLauncher(t, exitServer, manifest);
  const manifestPath = join(dir, ".next-desktop", "prerender-manifest.json");

  const seen = [];
  for (let run = 0; run < 2; run += 1) {
    const result = runLauncher(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /could not rotate/);
    const rotated = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.deepEqual(rotated.routes, manifest.routes, "the rest of the manifest is kept");
    assert.equal(rotated.version, 4);
    assert.match(rotated.preview.previewModeId, /^[0-9a-f]{32}$/);
    assert.match(rotated.preview.previewModeSigningKey, /^[0-9a-f]{64}$/);
    assert.match(rotated.preview.previewModeEncryptionKey, /^[0-9a-f]{64}$/);
    for (const [key, shipped] of Object.entries(SHIPPED)) {
      assert.notEqual(rotated.preview[key], shipped, `${key} is no longer the shipped value`);
    }
    seen.push(rotated.preview.previewModeId);
  }
  assert.notEqual(seen[0], seen[1], "each start gets its own id");
});

test("the launcher strips the revalidate headers from every request, after the timing hook unwraps too", async (t) => {
  const server = `
const http = require("node:http");
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(request.headers));
});
server.listen(0, "127.0.0.1", async () => {
  const { port } = server.address();
  const get = () => new Promise((resolve, reject) => {
    http.get({
      host: "127.0.0.1",
      port,
      path: "/",
      headers: {
        "x-prerender-revalidate": ${JSON.stringify(SHIPPED.previewModeId)},
        "x-prerender-revalidate-if-generated": "1",
        "x-kept": "yes",
      },
    }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
  // The first request is also the one the startup-timing hook unwraps on.
  const results = [await get(), await get(), await get()];
  process.stdout.write(JSON.stringify(results));
  process.exit(0);
});
`;
  const dir = await stageLauncher(t, server, { preview: { ...SHIPPED } });
  const result = runLauncher(dir);
  assert.equal(result.status, 0, result.stderr);
  const jsonStart = result.stdout.indexOf("[");
  const results = JSON.parse(result.stdout.slice(jsonStart));
  assert.equal(results.length, 3);
  for (const headers of results) {
    assert.equal(headers["x-prerender-revalidate"], undefined);
    assert.equal(headers["x-prerender-revalidate-if-generated"], undefined);
    assert.equal(headers["x-kept"], "yes", "other headers are left alone");
  }
});

test("a manifest the launcher cannot rotate is reported and the server still starts", async (t) => {
  const dir = await stageLauncher(t, `console.log("server started"); process.exit(0);\n`, "{ not json");
  const result = runLauncher(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[Pi Agent\] could not rotate preview-mode secrets/);
  assert.match(result.stdout, /server started/);
});

test("a build without a prerender manifest starts quietly", async (t) => {
  const dir = await stageLauncher(t, `console.log("server started"); process.exit(0);\n`);
  const result = runLauncher(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /could not rotate/);
  assert.match(result.stdout, /server started/);
});
