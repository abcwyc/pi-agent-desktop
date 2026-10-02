"use client";

import { useMemo } from "react";
import type { ToolEntry } from "@/lib/tool-presets";

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  loading: boolean;
  tools: ToolEntry[] | null;
  translate: Translate;
}

interface McpServerSummary {
  name: string;
  exposure: string;
  active: boolean;
  toolCount: number;
}

function mcpServerName(tool: ToolEntry): string | null {
  if (!tool.name.startsWith("mcp__")) return null;
  const suffix = tool.name.slice(5);
  const delimiter = suffix.lastIndexOf("__");
  return delimiter === -1 ? suffix : suffix.slice(0, delimiter);
}

export function summarizeMcpTools(tools: ToolEntry[]): McpServerSummary[] {
  const servers = new Map<string, McpServerSummary>();
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

export function McpPanel({ loading, tools, translate }: Props) {
  const servers = useMemo(() => tools ? summarizeMcpTools(tools) : null, [tools]);
  const totalTools = servers?.reduce((sum, server) => sum + server.toolCount, 0) ?? 0;

  return (
    <section className="mcp-panel" aria-label={translate("mcp.title")}>
      <header className="mcp-panel-header">
        <div>
          <h2>{translate("mcp.title")}</h2>
          <p>
            {servers
              ? translate("mcp.summary", { servers: servers.length, tools: totalTools })
              : loading
                ? translate("mcp.loading")
                : translate("mcp.load")}
          </p>
        </div>
      </header>

      <div className="mcp-server-scroll">
        {servers?.length ? servers.map((server) => (
          <article key={server.name} className={`mcp-server-card${server.active ? " connected" : ""}`}>
            <div className="mcp-server-title">
              <code>{server.name}</code>
              <span className="mcp-exposure">{translate(`tools.exposure.${server.exposure}`)}</span>
            </div>
            <dl>
              <div>
                <dt>{translate("mcp.tools")}</dt>
                <dd>{server.toolCount}</dd>
              </div>
              <div>
                <dt>{translate("mcp.status")}</dt>
                <dd>{server.active ? translate("mcp.declared") : translate("mcp.indirect")}</dd>
              </div>
            </dl>
          </article>
        )) : servers ? (
          <div className="mcp-empty">{translate("mcp.empty")}</div>
        ) : (
          <div className="mcp-empty">
            {loading ? translate("mcp.loading") : translate("mcp.load")}
          </div>
        )}
      </div>

      <footer className="mcp-panel-footer">
        <span>{translate("mcp.manageHint")}</span>
        <code>/mcp</code>
      </footer>

      <style>{`
        .mcp-panel {
          display: flex;
          height: min(600px, 75dvh);
          min-height: 240px;
          flex-direction: column;
          overflow: hidden;
          background: var(--bg-panel);
          border-bottom: 1px solid var(--border);
        }
        .mcp-panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 15px 18px 13px;
          border-bottom: 1px solid var(--border);
          background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 12%, transparent), transparent 68%);
        }
        .mcp-panel-header h2 {
          margin: 0;
          color: var(--text);
          font-size: 14px;
          font-weight: 750;
        }
        .mcp-panel-header p {
          margin: 3px 0 0;
          color: var(--text-muted);
          font-size: 11.5px;
        }
        .mcp-server-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
          padding: 14px 16px 18px;
        }
        .mcp-server-card {
          padding: 12px 14px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: color-mix(in srgb, var(--bg) 72%, var(--bg-panel));
          box-shadow: 0 1px 0 rgba(0, 0, 0, 0.03);
        }
        .mcp-server-card + .mcp-server-card {
          margin-top: 9px;
        }
        .mcp-server-card.connected {
          border-color: color-mix(in srgb, var(--accent) 38%, var(--border));
        }
        .mcp-server-title {
          display: flex;
          min-width: 0;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }
        .mcp-server-title code {
          min-width: 0;
          overflow-wrap: anywhere;
          color: var(--text);
          font-size: 12px;
          font-weight: 700;
        }
        .mcp-exposure {
          flex-shrink: 0;
          padding: 2px 7px;
          border: 1px solid color-mix(in srgb, var(--accent) 42%, transparent);
          border-radius: 999px;
          color: var(--accent);
          font-size: 9px;
          font-weight: 750;
          text-transform: uppercase;
        }
        .mcp-server-card dl {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
          margin: 10px 0 0;
        }
        .mcp-server-card dt {
          color: var(--text-dim);
          font-size: 10px;
          font-weight: 650;
          text-transform: uppercase;
        }
        .mcp-server-card dd {
          margin: 3px 0 0;
          color: var(--text-muted);
          font-size: 12px;
        }
        .mcp-empty,
        .mcp-panel-footer {
          color: var(--text-muted);
          font-size: 12px;
        }
        .mcp-empty {
          padding: 12px 2px;
          font-style: italic;
        }
        .mcp-panel-footer {
          display: flex;
          align-items: center;
          gap: 7px;
          padding: 10px 18px;
          border-top: 1px solid var(--border);
          background: color-mix(in srgb, var(--bg) 65%, var(--bg-panel));
        }
        .mcp-panel-footer code {
          color: var(--text);
        }
        @media (max-width: 640px) {
          .mcp-server-card dl {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </section>
  );
}
