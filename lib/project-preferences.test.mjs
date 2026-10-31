import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readProjectPreferences: read, changeProjectPreferences: change } = await jiti.import("./project-preferences.ts");
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "project-prefs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "projects.json");
}

test("rename and removal survive an independent process restart", t => {
  const path = fixture(t);
  change({ action: "rename", path: "D:\\Work\\App", name: "  业务项目  " }, path);
  change({ action: "archive", path: "D:/Other/App" }, path);
  const script = `import { createJiti } from 'jiti'; const jiti = createJiti(import.meta.url); const m = await jiti.import(process.argv[1]); console.log(JSON.stringify(m.readProjectPreferences(process.argv[2])));`;
  const loaded = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script,
    fileURLToPath(new URL("./project-preferences.ts", import.meta.url)), path], { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8" }));
  assert.deepEqual(loaded, { initialized: true, names: { "d:/work/app": "业务项目" }, archived: ["D:/Other/App"] });
});

test("legacy migration happens once, even after reset and restore", t => {
  const path = fixture(t);
  const old = { action: "migrate", names: { "D:/App": "旧名" }, archived: ["D:/App"] };
  assert.equal(read(path).initialized, false);
  change(old, path);
  change({ action: "rename", path: "D:/App", name: "" }, path);
  change({ action: "restore", path: "d:\\app" }, path);
  change(old, path);
  assert.deepEqual(read(path), { initialized: true, names: {}, archived: [] });
});

test("interleaved project operations preserve other roots and names", t => {
  const path = fixture(t);
  change({ action: "rename", path: "/one", name: "一" }, path);
  change({ action: "rename", path: "/two", name: "二" }, path);
  change({ action: "archive", path: "D:/App" }, path);
  change({ action: "archive", path: "d:\\app" }, path);
  change({ action: "rename", path: "/one", name: "" }, path);
  assert.deepEqual(read(path), { initialized: true, names: { "/two": "二" }, archived: ["d:\\app"] });
});

test("corrupt files are reported instead of silently overwritten", t => {
  const path = fixture(t);
  writeFileSync(path, "{broken");
  assert.throws(() => read(path));
  assert.throws(() => change({ action: "rename", path: "/one", name: "new" }, path));
  assert.equal(readFileSync(path, "utf8"), "{broken");
});
