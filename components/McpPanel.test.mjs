import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { summarizeMcpTools } = await jiti.import("../lib/mcp-status.ts");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const panelSource = await readFile(new URL("./McpPanel.tsx", import.meta.url), "utf8");

test("summarizes direct and indirect tools by MCP server", () => {
  const servers = summarizeMcpTools([
    { name: "mcp__alpha__search", description: "", active: false, exposure: "codemode" },
    { name: "mcp__alpha__read", description: "", active: true, exposure: "direct" },
    { name: "mcp__beta__run", description: "", active: false, exposure: "deferred" },
    { name: "read", description: "", active: true },
  ]);

  assert.deepEqual(servers, [
    { name: "alpha", exposure: "direct", active: true, toolCount: 2 },
    { name: "beta", exposure: "deferred", active: false, toolCount: 1 },
  ]);
});

test("MCP panel is reachable from the More menu", () => {
  assert.match(appShellSource, /handleSystemInfoToggle\("mcp"\)/);
  assert.match(appShellSource, /activeTopPanel === "mcp"[\s\S]*?<McpPanel/);
  assert.match(panelSource, /fetch\("\/api\/mcp"/);
  assert.match(panelSource, /new URLSearchParams\(\{ cwd \}\)/);
  assert.match(panelSource, /action: "disable"/);
  assert.match(panelSource, /action: "exposure", exposure/);
  assert.match(panelSource, /mcp-panel/);
  assert.match(panelSource, /function redactUrl/);
  assert.match(panelSource, /url\.search = ""/);
  assert.match(panelSource, /role="listbox"/);
});
