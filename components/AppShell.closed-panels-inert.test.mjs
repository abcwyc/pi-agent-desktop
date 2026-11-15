import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const theme = await readFile(new URL("../app/native-theme.css", import.meta.url), "utf8");

function openingTag(id) {
  const start = shell.indexOf(`id="${id}"`);
  assert.ok(start > 0, `#${id} not found`);
  return shell.slice(start, shell.indexOf(">\n", start));
}

// Closed, both side panels are only slid off-screen or squeezed to 0px. Without
// inert their controls stay in the Tab order and the accessibility tree.
test("the closed sidebar is inert", () => {
  assert.match(openingTag("session-sidebar"), /inert=\{rightPanelFullWidth \|\| !sidebarOpen \|\| \(isMobile && !mobileSidebarReady\)\}/);
});

test("the closed right panel is inert", () => {
  assert.match(openingTag("file-panel"), /inert=\{!rightPanelOpen\}/);
});

test("sidebar rows and icon buttons are finger-sized on a coarse pointer", () => {
  const start = theme.indexOf("@media (pointer: coarse) {\n  .app-sidebar .session-item");
  assert.ok(start > 0, "coarse-pointer sidebar block missing");
  const block = theme.slice(start, theme.indexOf("\n}\n", start));
  for (const rule of [
    /\.app-sidebar \.session-item \{ --session-row-height: 44px; \}/,
    /\.app-sidebar \.sidebar-header-row \{ height: 44px; \}/,
    /\.app-sidebar \.sidebar-project-tree-action,[\s\S]*?width: 44px;\s*height: 44px;/,
    /\.right-panel-toggle-button \{[\s\S]*?width: 44px !important;[\s\S]*?height: 44px;/,
  ]) assert.match(block, rule);
});
