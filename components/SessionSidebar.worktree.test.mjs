import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("uses the server-resolved current worktree identity", () => {
  assert.match(source, /currentWorktreePath: string \| null/);
  assert.match(
    source,
    /const currentWorktree =[\s\S]*?worktreeState\.currentWorktreePath[\s\S]*?worktree\.path === worktreeState\.currentWorktreePath/,
  );
  // Removing the selected worktree falls back to the project root, matched by
  // the server-resolved path (the project menu's worktree page).
  assert.match(source, /if \(currentWorktreePath === path \|\| selectedCwd === path\) setSelectedCwd\(projectRoot\)/);
  // The active project's branch subtitle reads the same identity.
  assert.match(source, /const currentWt = currentWorktree \?\? null;/);
  assert.doesNotMatch(source, /const isCurrent = wt\.path === selectedCwd/);
});
