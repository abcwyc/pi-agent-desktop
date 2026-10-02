import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": new URL("./mcp-config-sdk-stub.mjs", import.meta.url).pathname,
    "./project-trust": new URL("./mcp-config-trust-stub.mjs", import.meta.url).pathname,
  },
  tsconfigPaths: true,
});
const {
  readMcpConfigFromPaths,
  updateMcpServerConfig,
} = await jiti.import("./mcp-config.ts");

test("reads global and trusted project MCP config with project override precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-config-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  await mkdir(join(agentDir), { recursive: true });
  await mkdir(join(projectDir, ".pi"), { recursive: true });
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({
    mcpServers: {
      alpha: { command: "alpha", args: ["--global"] },
      beta: {
        url: "https://user:pass@beta.example/mcp?ACCESS_KEY=secret&next=1",
        exposure: "deferred",
      },
    },
  }, null, 2));
  await writeFile(join(projectDir, ".pi", "mcp.json"), JSON.stringify({
    mcpServers: {
      alpha: { command: "project-alpha" },
    },
  }, null, 2));

  try {
    const snapshot = readMcpConfigFromPaths(agentDir, projectDir, true);
    assert.deepEqual(snapshot.errors, []);
    assert.deepEqual(snapshot.servers.map(({ name, scope, transportSummary }) => ({ name, scope, transportSummary })), [
      { name: "alpha", scope: "project", transportSummary: "project-alpha" },
      { name: "beta", scope: "global", transportSummary: "https://beta.example/mcp" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project MCP config is withheld from untrusted projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-untrusted-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  await mkdir(join(agentDir), { recursive: true });
  await mkdir(join(projectDir, ".pi"), { recursive: true });
  await writeFile(join(projectDir, ".pi", "mcp.json"), JSON.stringify({
    mcpServers: { project: { command: "project" } },
  }));

  try {
    const snapshot = readMcpConfigFromPaths(agentDir, projectDir, false);
    assert.equal(snapshot.servers.length, 0);
    assert.match(snapshot.errors[0], /unavailable until the project is trusted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updates preserve unrelated config and default keys by removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-update-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  const configPath = join(agentDir, "mcp.json");
  await mkdir(agentDir, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    unrelated: true,
    mcpServers: {
      alpha: { command: "alpha", enabled: false, exposure: "deferred", timeout: 7 },
    },
  }, null, 4));

  try {
    const [server] = readMcpConfigFromPaths(agentDir, projectDir, false).servers;
    assert.equal(server.enabled, false);
    updateMcpServerConfig(server, { action: "enable" });
    updateMcpServerConfig(server, { action: "exposure", exposure: "codemode" });

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.unrelated, true);
    assert.equal(saved.mcpServers.alpha.timeout, 7);
    assert.equal("enabled" in saved.mcpServers.alpha, false);
    assert.equal("exposure" in saved.mcpServers.alpha, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
