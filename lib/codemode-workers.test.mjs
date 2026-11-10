import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { applyCodemodeWorkerDefault, PI_WEB_CODEMODE_MAX_WORKERS } = await jiti.import("./codemode-workers.ts");

test("an unset or empty PI_CODEMODE_MAX_WORKERS gets pi-web's default", () => {
  const unset = {};
  applyCodemodeWorkerDefault(unset);
  assert.equal(unset.PI_CODEMODE_MAX_WORKERS, "8");
  assert.equal(PI_WEB_CODEMODE_MAX_WORKERS, 8);

  const empty = { PI_CODEMODE_MAX_WORKERS: "" };
  applyCodemodeWorkerDefault(empty);
  assert.equal(empty.PI_CODEMODE_MAX_WORKERS, "8");
});

test("a PI_CODEMODE_MAX_WORKERS the user set is kept, even one pi rejects", () => {
  for (const value of ["2", "16", "0", "abc"]) {
    const env = { PI_CODEMODE_MAX_WORKERS: value };
    applyCodemodeWorkerDefault(env);
    assert.equal(env.PI_CODEMODE_MAX_WORKERS, value);
  }
});

test("the SDK still reads PI_CODEMODE_MAX_WORKERS on every script", async () => {
  // Fails when pi renames the variable or stops reading it per call, which
  // would leave pi-web's default without effect.
  const source = await readFile(
    new URL("../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/execute.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /function maxCodemodeWorkers\(\) \{\s*const value = Number\(process\.env\.PI_CODEMODE_MAX_WORKERS\);/);
  assert.match(source, /activeCodemodeWorkers < maxCodemodeWorkers\(\)/);
});
