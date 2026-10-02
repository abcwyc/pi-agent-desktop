import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("GET merges config entries with live session tool registration", () => {
  assert.match(source, /readMcpConfig\(cwd\)/);
  assert.match(source, /getRpcSession\(sessionId\)/);
  assert.match(source, /summarizeMcpTools\(tools \?\? \[\]\)/);
});

test("POST validates and atomically patches known MCP entries", () => {
  assert.match(source, /action must be enable, disable, or exposure/);
  assert.match(source, /isMcpExposure\(body\.exposure\)/);
  assert.match(source, /findMcpServer\(cwd, serverName\)/);
  assert.match(source, /updateMcpServerConfig\(server, patch\)/);
  assert.doesNotMatch(source, /mcpServers\[body\.server\]/);
});
