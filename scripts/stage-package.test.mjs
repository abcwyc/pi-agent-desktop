import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findStagedCopies, stageCompletePackage } from "./stage-package.mjs";

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
