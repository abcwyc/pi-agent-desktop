import { NextResponse } from "next/server";

import {
  findMcpServer,
  isMcpExposure,
  readMcpConfig,
  updateMcpServerConfig,
  type McpExposure,
} from "@/lib/mcp-config";
import { summarizeMcpTools } from "@/lib/mcp-status";
import { getRpcSession } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

function cwdFrom(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

async function readTools(sessionId: string) {
  const session = getRpcSession(sessionId);
  if (!session) return null;
  const result = await session.send({ type: "get_tools" }) as Array<{
    name: string;
    active?: boolean;
    exposure?: string;
    sourceInfo?: unknown;
  }>;
  return result.map((tool) => ({
    name: tool.name,
    description: "",
    active: tool.active === true,
    exposure: tool.exposure as never,
    sourceInfo: tool.sourceInfo,
  }));
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const cwd = cwdFrom(searchParams.get("cwd"));
    if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });

    const config = readMcpConfig(cwd);
    const sessionId = cwdFrom(searchParams.get("sessionId"));
    let tools: Awaited<ReturnType<typeof readTools>> = null;
    if (sessionId) {
      try {
        tools = await readTools(sessionId);
      } catch (error) {
        console.error("Failed to read live MCP tools:", error);
      }
    }
    const summaries = summarizeMcpTools(tools ?? []);
    return NextResponse.json({
      servers: config.servers.map((server) => {
        const summary = summaries.find((item) => item.name === server.name);
        return {
          ...server,
          connected: summary?.toolCount ? true : false,
          toolCount: summary?.toolCount ?? 0,
          declared: summary?.active ?? false,
        };
      }),
      errors: config.errors,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      cwd?: unknown;
      server?: unknown;
      action?: unknown;
      exposure?: unknown;
    };
    const cwd = cwdFrom(body.cwd);
    const serverName = cwdFrom(body.server);
    if (!cwd || !serverName) {
      return NextResponse.json({ error: "cwd and server are required" }, { status: 400 });
    }

    const action = body.action as "enable" | "disable" | "exposure";
    if (action !== "enable" && action !== "disable" && action !== "exposure") {
      return NextResponse.json({ error: "action must be enable, disable, or exposure" }, { status: 400 });
    }
    if (action === "exposure" && !isMcpExposure(body.exposure)) {
      return NextResponse.json({ error: "exposure is invalid" }, { status: 400 });
    }

    const server = findMcpServer(cwd, serverName);
    if (!server) return NextResponse.json({ error: `Unknown MCP server: ${serverName}` }, { status: 404 });

    const patch = action === "exposure"
      ? { action, exposure: body.exposure as McpExposure }
      : { action };
    updateMcpServerConfig(server, patch);
    return NextResponse.json({ success: true, server: findMcpServer(cwd, serverName) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
