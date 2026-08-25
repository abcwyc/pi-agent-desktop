import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("exposes an accessible project-tree resize separator", () => {
  assert.match(appShellSource, /data-resize-handle="file-tree"/);
  assert.match(appShellSource, /aria-controls="file-tree-panel"/);
  assert.match(appShellSource, /storageKey: "pi-file-tree-width"/);
});

test("reclamps the project tree when the available file panel changes", () => {
  assert.match(appShellSource, /const getFileTreeMaxWidth = useCallback/);
  assert.match(appShellSource, /window\.innerWidth < MOBILE_MAX_WIDTH/);
  assert.match(appShellSource, /reclampFileTreeWidth\(\)/);
  assert.match(appShellSource, /rightPanelWidth\]\);/);
});
