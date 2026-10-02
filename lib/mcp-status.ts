import type { ToolEntry } from "./tool-presets";

export interface McpToolSummary {
  name: string;
  exposure: string;
  active: boolean;
  toolCount: number;
}

export function mcpServerName(tool: ToolEntry): string | null {
  if (!tool.name.startsWith("mcp__")) return null;
  const suffix = tool.name.slice(5);
  const delimiter = suffix.lastIndexOf("__");
  return delimiter === -1 ? suffix : suffix.slice(0, delimiter);
}

export function summarizeMcpTools(tools: ToolEntry[]): McpToolSummary[] {
  const servers = new Map<string, McpToolSummary>();
  for (const tool of tools) {
    const name = mcpServerName(tool);
    if (!name) continue;
    const current = servers.get(name) ?? {
      name,
      exposure: tool.exposure ?? "direct",
      active: false,
      toolCount: 0,
    };
    current.toolCount += 1;
    current.active = current.active || tool.active;
    if ((tool.exposure ?? "direct") === "direct") current.exposure = "direct";
    servers.set(name, current);
  }
  return [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));
}
