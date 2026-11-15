import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the file viewer toolbar names the platform's file manager and reports failures", async () => {
  const viewer = await read("./FileViewer.tsx");
  assert.doesNotMatch(viewer, /"Reveal in Finder"|"Open with default app"|"Live sync (active|unavailable)"/);
  assert.match(viewer, /t\(revealLabelKey\(getDesktopPlatform\(\)\)\)/);
  assert.match(viewer, /appNotify\.error\(/);
});

test("the project picker's own copy goes through translations", async () => {
  const picker = await read("./ProjectPicker.tsx");
  for (const literal of ["Select project…", "Filter projects…", "No matching projects", "Use default directory", "Open Folder…"]) {
    assert.ok(!picker.includes(literal), `ProjectPicker still hard-codes "${literal}"`);
  }
});

for (const [file, loader] of [["./SkillsConfig.tsx", "loadSkills"], ["./PluginsConfig.tsx", "loadPlugins"]]) {
  test(`${file} ignores a ${loader} response that a newer load superseded`, async () => {
    const source = await read(file);
    const start = source.indexOf(`const ${loader} = useCallback(async () => {`);
    assert.ok(start > 0, `${loader} not found`);
    const body = source.slice(start, source.indexOf("}, [cwd]);", start));
    assert.match(body, /const requestId = \+\+loadRequestRef\.current;/);
    // The guard runs before any state write from the response.
    const guard = body.indexOf("if (!isCurrent()) return");
    assert.ok(guard > 0 && guard < body.indexOf("if (!res.ok"), "stale guard must precede the response handling");
    assert.match(body, /if \(isCurrent\(\)\) setLoading\(false\)/);
  });
}
