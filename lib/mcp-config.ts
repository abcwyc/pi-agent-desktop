import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { getProjectTrustStatus } from "./project-trust";

export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";

export interface McpServerConfigEntry {
  name: string;
  enabled: boolean;
  exposure: McpExposure;
  transport: "stdio" | "http";
  transportSummary: string;
  source: string;
  scope: "global" | "project";
}

export interface McpConfigSnapshot {
  servers: McpServerConfigEntry[];
  errors: string[];
}

export type McpConfigPatch =
  | { action: "enable" }
  | { action: "disable" }
  | { action: "exposure"; exposure: McpExposure };

interface LoadedServer {
  config: Record<string, unknown>;
  source: string;
  scope: "global" | "project";
}

const EXPOSURES = new Set<McpExposure>(["codemode", "deferred", "direct", "hidden"]);

export function isMcpExposure(value: unknown): value is McpExposure {
  return typeof value === "string" && EXPOSURES.has(value as McpExposure);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigFile(path: string, scope: "global" | "project", state: Map<string, LoadedServer>, errors: string[]): void {
  if (!existsSync(path)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    errors.push(`${path}: expected an object with an "mcpServers" object`);
    return;
  }
  for (const [name, raw] of Object.entries(parsed.mcpServers ?? {})) {
    if (!isRecord(raw)) {
      errors.push(`${path}: server "${name}" must be an object`);
      continue;
    }
    // Project entries replace global entries, matching Pi's loader.
    state.set(name, { config: raw, source: path, scope });
  }
}

export function readMcpConfigFromPaths(
  agentDir: string,
  cwd: string,
  projectTrusted: boolean,
): McpConfigSnapshot {
  const loaded = new Map<string, LoadedServer>();
  const errors: string[] = [];
  readConfigFile(join(agentDir, "mcp.json"), "global", loaded, errors);

  const projectPath = join(cwd, ".pi", "mcp.json");
  if (existsSync(projectPath)) {
    if (!projectTrusted) {
      errors.push(`${projectPath}: project MCP config is unavailable until the project is trusted`);
    } else {
      readConfigFile(projectPath, "project", loaded, errors);
    }
  }

  return {
    servers: [...loaded.entries()].map(([name, { config, source, scope }]) => ({
      name,
      enabled: config.enabled !== false,
      exposure: isMcpExposure(config.exposure) ? config.exposure : "codemode",
      transport: typeof config.url === "string" ? "http" : "stdio",
      transportSummary: describeTransport(config),
      source,
      scope,
    })),
    errors,
  };
}

export function readMcpConfig(cwd: string): McpConfigSnapshot {
  const agentDir = getAgentDir();
  return readMcpConfigFromPaths(
    agentDir,
    cwd,
    getProjectTrustStatus(cwd, agentDir).trusted,
  );
}

function describeTransport(config: Record<string, unknown>): string {
  if (typeof config.url === "string") return redactUrl(config.url);
  const command = typeof config.command === "string" ? config.command : "(missing command)";
  const args = Array.isArray(config.args) ? config.args.filter((arg) => typeof arg === "string") : [];
  return [command, ...args].join(" ");
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

export function findMcpServer(cwd: string, name: string): McpServerConfigEntry | undefined {
  return readMcpConfig(cwd).servers.find((server) => server.name === name);
}

function writeAtomic(path: string, contents: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(dir, `.${basename(path)}-${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${contents}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(tempPath, path);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // The rename either consumed the temporary file or it never existed.
    }
  }
}

export function updateMcpServerConfig(
  server: McpServerConfigEntry,
  patch: McpConfigPatch,
): void {
  if (!existsSync(server.source)) {
    throw new Error(`MCP config file no longer exists: ${server.source}`);
  }
  const text = readFileSync(server.source, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new Error(`${server.source}: expected an object with an "mcpServers" object`);
  }
  const servers = parsed.mcpServers as Record<string, Record<string, unknown>>;
  const config = servers[server.name];
  if (!isRecord(config)) throw new Error(`${server.source} does not define MCP server "${server.name}"`);

  if (patch.action === "enable") delete config.enabled;
  else if (patch.action === "disable") config.enabled = false;
  else if (patch.exposure === "codemode") delete config.exposure;
  else config.exposure = patch.exposure;

  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";
  writeAtomic(server.source, JSON.stringify(parsed, null, indent));
}
