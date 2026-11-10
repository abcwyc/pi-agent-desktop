import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("the Git changes switch between a flat list and a folder tree, remembered per browser (F2)", () => {
  assert.match(source, /getPref\(APP_PREF_KEYS\.changesViewMode\) === "tree" \? "tree" : "list"/);
  assert.match(source, /setPref\(APP_PREF_KEYS\.changesViewMode, next\)/);
  // The tree is built from paths relative to the project, the list stays as it was.
  assert.match(source, /const changesTree = useMemo\(\(\) => buildSearchTree\(\[\.\.\.changesByRelativePath\.keys\(\)\]\), \[changesByRelativePath\]\);/);
  assert.match(source, /\{changesViewMode === "tree" \? \(\s*<ChangesTreeRows/);
  assert.match(source, /aria-pressed=\{changesViewMode === "tree"\}/);
  // Folders start open and stay so across refreshes; only a click folds one.
  assert.match(source, /const open = !collapsedPaths\.has\(node\.path\);/);
  // In the tree the folders name the path, so a row shows the file name only.
  assert.match(source, /const dirPart = !treeMode && lastSlash >= 0/);
});
