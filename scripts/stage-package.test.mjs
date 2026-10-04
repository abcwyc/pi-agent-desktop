import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { dedupeNestedPackages, findNestedPiScopePackages, findStagedCopies, stageCompletePackage } from "./stage-package.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stage-package-"));
  const source = join(root, "source", "quickjs-wasi");
  await mkdir(join(source, "dist"), { recursive: true });
  await writeFile(join(source, "package.json"), '{"name":"quickjs-wasi","version":"3.6.2"}');
  await writeFile(join(source, "quickjs.wasm"), "wasm");
  await writeFile(join(source, "dist", "index.js"), "full");
  const staged = join(root, "staged", "node_modules");
  await mkdir(staged, { recursive: true });
  return { root, source, staged, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function partialCopy(dir) {
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "package.json"), '{"name":"quickjs-wasi","version":"3.6.2"}');
  await writeFile(join(dir, "dist", "index.js"), "traced");
}

const hasWasm = (dir) => readFile(join(dir, "quickjs.wasm"), "utf8").then((text) => text === "wasm", () => false);

test("completes a traced top-level copy (pi 1.0.1 layout)", async () => {
  const f = await fixture();
  try {
    await partialCopy(join(f.staged, "quickjs-wasi"));
    const written = await stageCompletePackage({ name: "quickjs-wasi", sources: [f.source], stagedNodeModulesDir: f.staged });
    assert.deepEqual(written, [join(f.staged, "quickjs-wasi")]);
    assert.equal(await hasWasm(join(f.staged, "quickjs-wasi")), true);
    assert.equal(await readFile(join(f.staged, "quickjs-wasi", "dist", "index.js"), "utf8"), "full");
  } finally {
    await f.cleanup();
  }
});

test("completes a nested copy when nothing is hoisted (pi 1.0.0 layout)", async () => {
  const f = await fixture();
  try {
    const nested = join(f.staged, "@earendil-works", "pi-coding-agent", "node_modules", "quickjs-wasi");
    await partialCopy(nested);
    const written = await stageCompletePackage({ name: "quickjs-wasi", sources: [f.source], stagedNodeModulesDir: f.staged });
    assert.deepEqual(written, [nested]);
    assert.equal(await hasWasm(nested), true);
    assert.equal(await findStagedCopies(f.staged, "quickjs-wasi").then((copies) => copies.length), 1);
  } finally {
    await f.cleanup();
  }
});

test("completes every copy when the top level and a nested one both exist", async () => {
  const f = await fixture();
  try {
    const top = join(f.staged, "quickjs-wasi");
    const nested = join(f.staged, "some-pkg", "node_modules", "quickjs-wasi");
    await partialCopy(top);
    await partialCopy(nested);
    const written = await stageCompletePackage({ name: "quickjs-wasi", sources: [f.source], stagedNodeModulesDir: f.staged });
    assert.deepEqual(written.sort(), [nested, top].sort());
    assert.equal(await hasWasm(top), true);
    assert.equal(await hasWasm(nested), true);
  } finally {
    await f.cleanup();
  }
});

test("falls back to the top level when the tracer kept no copy", async () => {
  const f = await fixture();
  try {
    const written = await stageCompletePackage({ name: "quickjs-wasi", sources: [f.source], stagedNodeModulesDir: f.staged });
    assert.deepEqual(written, [join(f.staged, "quickjs-wasi")]);
    assert.equal(await hasWasm(join(f.staged, "quickjs-wasi")), true);
  } finally {
    await f.cleanup();
  }
});

test("uses the first readable source and refuses when none exists", async () => {
  const f = await fixture();
  try {
    const missing = join(f.root, "nope");
    await stageCompletePackage({ name: "quickjs-wasi", sources: [missing, f.source], stagedNodeModulesDir: f.staged });
    assert.equal(await hasWasm(join(f.staged, "quickjs-wasi")), true);
    await assert.rejects(
      stageCompletePackage({ name: "quickjs-wasi", sources: [missing], stagedNodeModulesDir: f.staged }),
      /quickjs-wasi not found under node_modules/,
    );
  } finally {
    await f.cleanup();
  }
});

async function piFixture() {
  const root = await mkdtemp(join(tmpdir(), "stage-package-pi-"));
  const server = join(root, "resources", "server");
  const staged = join(server, "node_modules");
  await mkdir(staged, { recursive: true });
  return { root, server, staged, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function stagedPiPackage(staged, name, version, files = ["dist/index.js"]) {
  const dir = join(staged, "@earendil-works", name);
  await mkdir(dir, { recursive: true });
  if (version !== null) {
    await writeFile(join(dir, "package.json"), `{"name":"@earendil-works/${name}","version":"${version}"}`);
  }
  for (const file of files) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), "");
  }
  return dir;
}

test("dedupeNestedPackages removes a same-version nested copy", async () => {
  const f = await piFixture();
  try {
    await stagedPiPackage(f.staged, "pi-agent-core", "1.0.2");
    const agentDir = await stagedPiPackage(f.staged, "pi-coding-agent", "1.0.2");
    const nested = await stagedPiPackage(
      join(agentDir, "node_modules"),
      "pi-agent-core",
      "1.0.2",
    );
    const removed = await dedupeNestedPackages(f.server, () => {});
    assert.equal(removed, 1);
    assert.equal(await findStagedCopies(f.staged, "@earendil-works/pi-agent-core").then((c) => c.length), 1);
    assert.ok(!existsSync(nested));
    assert.equal((await findNestedPiScopePackages(f.staged)).length, 0);
  } finally {
    await f.cleanup();
  }
});

test("dedupeNestedPackages keeps a genuinely conflicting nested copy", async () => {
  const f = await piFixture();
  try {
    await stagedPiPackage(f.staged, "pi-agent-core", "1.0.2");
    const agentDir = await stagedPiPackage(f.staged, "pi-coding-agent", "1.0.2");
    await stagedPiPackage(join(agentDir, "node_modules"), "pi-agent-core", "0.87.1");
    const removed = await dedupeNestedPackages(f.server, () => {});
    assert.equal(removed, 0);
    // Kept — and therefore reported by the #72 build gate.
    assert.deepEqual(await findNestedPiScopePackages(f.staged), [
      join(agentDir, "node_modules", "@earendil-works", "pi-agent-core"),
    ]);
  } finally {
    await f.cleanup();
  }
});

test("dedupeNestedPackages warns and keeps nested pi copies when the top-level version is unreadable", async () => {
  const f = await piFixture();
  try {
    // The 0.4.7 payload shape: top-level pi-agent-core shipped dist/ only.
    await stagedPiPackage(f.staged, "pi-agent-core", null);
    const agentDir = await stagedPiPackage(f.staged, "pi-coding-agent", "0.87.1");
    await stagedPiPackage(join(agentDir, "node_modules"), "pi-agent-core", "0.87.1");
    const warnings = [];
    const removed = await dedupeNestedPackages(f.server, (message) => warnings.push(message));
    assert.equal(removed, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /pi-agent-core/);
    assert.deepEqual(await findNestedPiScopePackages(f.staged), [
      join(agentDir, "node_modules", "@earendil-works", "pi-agent-core"),
    ]);
  } finally {
    await f.cleanup();
  }
});

test("findNestedPiScopePackages ignores nested non-pi dependencies", async () => {
  const f = await piFixture();
  try {
    const agentDir = await stagedPiPackage(f.staged, "pi-coding-agent", "1.0.2");
    await mkdir(join(agentDir, "node_modules", "chalk"), { recursive: true });
    assert.deepEqual(await findNestedPiScopePackages(f.staged), []);
  } finally {
    await f.cleanup();
  }
});
