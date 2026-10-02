import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function checkMcpManager(page, { agentDir, cwd }) {
  // Write through the URL-facing cwd because `?cwd=` avoids restoring an
  // unrelated session from workspace memory.
  await page.goto(`${new URL(page.url()).origin}/?cwd=${encodeURIComponent(cwd)}`, {
    waitUntil: "domcontentloaded",
  });
  // Seed through the same isolated PI_CODING_AGENT_DIR as the server.
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({
    mcpServers: {
      alpha: { command: "echo", args: ["alpha"] },
      beta: { url: "https://beta.example/mcp?ACCESS_KEY=secret-token" },
    },
  }, null, 2));

  const more = page.getByRole("button", { name: "More session actions" });
  await more.click();
  await page.getByRole("menuitem").filter({ hasText: "MCP" }).click();
  const panel = page.getByRole("region", { name: "MCP servers" });
  await panel.waitFor();
  await panel.getByRole("option", { name: /alpha/ }).waitFor();
  await panel.getByRole("option", { name: /beta/ }).click();
  await panel.getByText("https://beta.example/mcp").waitFor();
  if (await panel.getByText("secret-token").count()) throw new Error("MCP manager leaked a credential-bearing query string");
  console.log("PASS: MCP manager master-detail layout and URL redaction");
}
