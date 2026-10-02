import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panelSource = await readFile(new URL("./ToolDefinitionsPanel.tsx", import.meta.url), "utf8");
const systemSource = await readFile(new URL("./SystemPromptPanel.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("keeps System and Tools reachable as separate top-panel actions", () => {
  // The desktop duplicate toolbar (renderChatToolbarActions) was folded into
  // the More menu; System and Tools entries must keep the lazy-loading toggle.
  assert.match(appShellSource, /handleSystemInfoToggle\("system"\)[\s\S]*?handleSystemInfoToggle\("tools"\)/);
  assert.match(appShellSource, /activeTopPanel === "system"[\s\S]*?<SystemPromptPanel/);
  assert.match(appShellSource, /activeTopPanel === "tools"[\s\S]*?<ToolDefinitionsPanel/);
  assert.doesNotMatch(systemSource, /ToolEntry|tools/);
  assert.doesNotMatch(systemSource, /system-prompt-heading/);
  assert.doesNotMatch(panelSource, /tool-definitions-heading/);
});

test("renders active tool definitions in a selectable master-detail layout", () => {
  assert.match(panelSource, /exposureFilter === "all" \|\| tool\.active/);
  assert.match(panelSource, /setSelectedToolName\(tool\.name\)/);
  assert.match(panelSource, /visibleTools\?\.some\(\(tool\) => tool\.name === current\)/);
  assert.match(panelSource, /className="tool-definitions-sidebar"/);
  assert.match(panelSource, /className="tool-definition-detail"/);
  assert.match(panelSource, /grid-template-columns: clamp\(112px, 26%, 220px\) minmax\(0, 1fr\)/);
});

test("keeps indirect Pi 1.0 MCP tools visible and labeled by exposure", () => {
  assert.match(panelSource, /normalizeExposure\(tool\.exposure\) !== "hidden"/);
  assert.match(panelSource, /exposureRank\(a\.exposure\) - exposureRank\(b\.exposure\)/);
  assert.match(panelSource, /tool-definitions-filters/);
  assert.match(panelSource, /tool-exposure-badge exposure-\$\{exposure\}/);
  assert.match(panelSource, /isMcpTool\(selectedTool\)/);
});

test("shows schema fields and metadata in the detail form", () => {
  assert.match(panelSource, /parameters\.properties/);
  assert.match(panelSource, /parameters\.required/);
  assert.match(panelSource, /field\.allowedValues/);
  assert.match(panelSource, /field\.defaultValue/);
  assert.match(panelSource, /selectedTool\.promptGuidelines/);
});

test("preserves the two-column layout on narrow screens", () => {
  assert.match(
    panelSource,
    /@media \(max-width: 640px\)[\s\S]*?\.tool-definitions-panel \{[\s\S]*?grid-template-columns: 112px minmax\(0, 1fr\)/,
  );
  assert.doesNotMatch(panelSource, /@media \(max-width: 640px\)[\s\S]*?\.tool-definitions-panel \{[\s\S]*?display: block/);
});
