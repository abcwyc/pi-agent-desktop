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

  // Settings › MCP lists the files' servers without a session (ADR 0006 P2).
  // The fork opens Settings from the sidebar header's gear, which pops the
  // section menu; a previous check may have left the sidebar collapsed.
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const mcpEntry = page.locator(".settings-entry-menu button", { hasText: "MCP" });
  await mcpEntry.waitFor();
  await mcpEntry.click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.waitFor();

  const alpha = dialog.getByRole("button", { name: /alpha/ });
  await alpha.waitFor();
  await alpha.click();
  const beta = dialog.getByRole("button", { name: /beta/ });
  await beta.click();
  // GET /api/mcp lists files only: the URL's query is masked server-side, so a
  // credential-bearing query string never reaches the browser.
  await dialog.getByText("https://beta.example/mcp?ACCESS_KEY=•••").waitFor();
  if (await dialog.getByText("secret-token").count()) throw new Error("MCP manager leaked a credential-bearing query string");
  await page.keyboard.press("Escape");
  console.log("PASS: Settings › MCP lists file-configured servers with masked URLs");
}
