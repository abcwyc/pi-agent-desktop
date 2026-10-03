import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const modelsConfig = await read("./ModelsConfig.tsx");
const settingsPanel = await read("./SettingsPanel.tsx");
const messageView = await read("./MessageView.tsx");

test("Settings › Models lists classifier and image models in their own entry", () => {
  assert.match(modelsConfig, /if \(selection\?\.type === "nonchat"\) return <NonChatModelsDetail onOpenMcp=\{onOpenMcp\} \/>;/);
  assert.match(modelsConfig, /onClick=\{\(\) => setSelection\(\{ type: "nonchat" \}\)\}/);
  // The pane links to the Code mode choice those models depend on.
  assert.match(settingsPanel, /<ModelsConfig [^>]*onOpenMcp=\{\(\) => activateSection\("mcp"\)\}/);
});

test("tool-result images can be saved, since pi never writes generated images to disk", () => {
  assert.match(messageView, /downloadUrlAsFile\(src, resultImageFileName\(imageMediaType\(image\), index\)\)/);
});
