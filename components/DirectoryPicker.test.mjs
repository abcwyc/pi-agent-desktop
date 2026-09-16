import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { visibleDirectoryEntries } = await jiti.import("./DirectoryPicker.tsx");

const entries = [
  { name: "zeta", path: "/zeta" },
  { name: "Alpha", path: "/Alpha" },
  { name: "beta", path: "/beta" },
];

test("filters names as typed, ignoring case and surrounding spaces", () => {
  assert.deepEqual(visibleDirectoryEntries(entries, "  ALP  ", false).map((entry) => entry.name), ["Alpha"]);
  assert.deepEqual(visibleDirectoryEntries(entries, "missing", false), []);
});

test("sorts alphabetically in both directions without mutating server results", () => {
  assert.deepEqual(visibleDirectoryEntries(entries, "", false).map((entry) => entry.name), ["Alpha", "beta", "zeta"]);
  assert.deepEqual(visibleDirectoryEntries(entries, "", true).map((entry) => entry.name), ["zeta", "beta", "Alpha"]);
  assert.deepEqual(entries.map((entry) => entry.name), ["zeta", "Alpha", "beta"]);
});
