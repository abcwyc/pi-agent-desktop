import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (path) => (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("a phone reads a patch in one column, whatever the diff view setting says (F7)", async () => {
  const source = await read("./MessageView.tsx");
  assert.match(source, /function usePatchLayout\(\): "split" \| "unified" \{[\s\S]*?return isMobile \? "unified" : mode;/);
  assert.match(source, /function ApplyPatchDiffView[\s\S]*?const mode = usePatchLayout\(\);/);
  assert.match(source, /function SplitPatchView[\s\S]*?const mode = usePatchLayout\(\);/);
});

test("the lines a diff leaves out between hunks are marked in both layouts and in the file viewer (F7)", async () => {
  const message = await read("./MessageView.tsx");
  assert.match(message, /if \(row\.type === "gap"\) return \[<DiffGapRow key=\{`\$\{rowIndex\}-g`\} count=\{row\.count\} \/>\];/);
  assert.match(message, /return <DiffGapRow key=\{rowIndex\} count=\{row\.count\} spanBoth \/>;/);
  assert.match(message, /count === null \? "⋯" : diffGapLabel\(count, t\)/);
  const viewer = await read("./FileViewer.tsx");
  assert.match(viewer, /if \(row\.type === "gap"\) return \[\{ type: "gap", count: row\.count \}\];/);
  assert.match(viewer, /seg\.count === null \? "⋯" : diffGapLabel\(seg\.count, t\)/);
  const theme = await read("../app/native-theme.css");
  assert.match(theme, /\.patch-diff-gap \{/);
});

test("a code block's long lines wrap by default and the button turns that off (C10)", async () => {
  const source = await read("./MermaidBlock.tsx");
  assert.match(source, /const \[wrap, setWrap\] = useState\(true\);/);
  assert.match(source, /\{wrap \? t\("chat\.codeNoWrap"\) : t\("chat\.codeWrap"\)\}/);
});
