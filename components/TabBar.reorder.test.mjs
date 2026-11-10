import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (file) => (await readFile(new URL(file, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("right-panel tabs drag into a new order that new tabs append to (A2)", async () => {
  const bar = await read("./TabBar.tsx");
  assert.match(bar, /draggable=\{Boolean\(onReorderTab\)\}/);
  assert.match(bar, /onReorderTab\?\.\(draggedId\.current, tab\.id, event\.clientX >= rect\.left \+ rect\.width \/ 2\);/);
  // The close button does not start a tab drag.
  assert.match(bar, /className="file-tab-close"\s*draggable=\{false\}\s*onDragStart=\{\(event\) => event\.stopPropagation\(\)\}/);
  const shell = await read("./AppShell.tsx");
  assert.match(shell, /orderPanelTabs\(\[\.\.\.fileTabs, /);
  assert.match(shell, /onReorderTab=\{\(source, target, after\) => setPanelTabOrder\(movePanelTab\(panelTabs\.map\(\(tab\) => tab\.id\), source, target, after\)\)\}/);
  // A closed tab leaves the order.
  assert.match(shell, /order\.filter\(\(id\) => open\.has\(id\)\)/);
});
