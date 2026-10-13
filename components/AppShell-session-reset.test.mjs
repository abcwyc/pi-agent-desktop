import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("starting another blank task remounts the composer even in the same cwd", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const handleNewSession = useCallback");
  const end = source.indexOf("// Global keyboard shortcuts", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = source.slice(start, end);
  assert.match(handler, /clearDraft\(`new:\$\{cwd\}`\)/);
  assert.match(handler, /setSessionKey\(\(key\) => key \+ 1\)/);
});

test("switching sessions immediately clears parent-owned session UI", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const handleSelectSession = useCallback");
  const end = source.indexOf("const handleNewSession = useCallback", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = source.slice(start, end);
  assert.match(handler, /setBranchTree\(\[\]\)/);
  assert.match(handler, /setBranchActiveLeafId\(null\)/);
  assert.match(handler, /branchLeafChangeFnRef\.current = null/);
  assert.match(handler, /setSessionStats\(null\)/);
  assert.match(handler, /setContextUsage\(null\)/);
  assert.match(handler, /setActiveTopPanel\(null\)/);
});

test("workspace restore stays desktop-only while server health covers web", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(source, /desktopMode \? getPrefJson<PersistedWorkspace>/);
  assert.match(source, /useDesktopConnection\(\)/);
  assert.match(source, /if \(!desktopMode \|\| !workspaceHydrated\) return/);
});
