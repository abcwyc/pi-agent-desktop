"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { McpExposure } from "@/lib/mcp-config";
import { summarizeMcpTools } from "@/lib/mcp-status";
import type { ToolEntry } from "@/lib/tool-presets";

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  loading: boolean;
  tools: ToolEntry[] | null;
  cwd: string | null;
  sessionId: string | null;
  translate: Translate;
}

interface McpServer {
  name: string;
  enabled: boolean;
  exposure: string;
  toolCount: number;
  connected: boolean;
  declared: boolean;
  transport: "stdio" | "http";
  transportSummary: string;
  source: string;
  scope: "global" | "project";
}

export function McpPanel({
  loading,
  tools,
  cwd,
  sessionId,
  translate,
}: Props) {
  const liveTools = useMemo(() => tools ?? [], [tools]);
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [configErrors, setConfigErrors] = useState<string[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [pendingServer, setPendingServer] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    if (!cwd) {
      setServers(null);
      return;
    }
    try {
      const response = await fetch("/api/mcp", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, ...(sessionId ? { sessionId } : {}) }),
      });
      const data = await response.json() as {
        servers?: McpServer[];
        errors?: string[];
        error?: string;
      };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setServers(data.servers ?? []);
      setConfigErrors(data.errors ?? []);
      setRequestError(null);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    }
  }, [cwd, sessionId]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const update = useCallback(async (
    server: McpServer,
    body: { action: "enable" | "disable" } | { action: "exposure"; exposure: McpExposure },
  ) => {
    setPendingServer(server.name);
    try {
      const response = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, server: server.name, ...body }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      await load();
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingServer(null);
    }
  }, [cwd, load]);

  const liveSummaries = useMemo(() => summarizeMcpTools(liveTools), [liveTools]);
  const totalTools = servers?.reduce((sum, server) => sum + server.toolCount, 0) ?? 0;
  const connectedCount = servers?.filter((server) => server.connected).length ?? 0;

  return (
    <section className="mcp-panel" aria-label={translate("mcp.title")}>
      <header className="mcp-panel-header">
        <div>
          <h2>{translate("mcp.title")}</h2>
          <p>
            {servers
              ? translate("mcp.summary", {
                servers: servers.length,
                connected: connectedCount,
                tools: totalTools,
              })
              : loading
                ? translate("mcp.loading")
                : translate("mcp.load")}
          </p>
        </div>
      </header>

      <div className="mcp-server-scroll">
        {requestError && <div className="mcp-config-error">{requestError}</div>}
        {configErrors.map((error) => <div key={error} className="mcp-config-error">{error}</div>)}
        {servers?.length ? servers.map((server) => {
          const summary = liveSummaries.find((item) => item.name === server.name);
          const pending = pendingServer === server.name;
          return (
          <article
            key={server.name}
            className={`mcp-server-card${server.connected ? " connected" : ""}${server.enabled ? "" : " disabled"}`}
          >
            <div className="mcp-server-title">
              <code>{server.name}</code>
              <div className="mcp-server-badges">
                <span className={`mcp-exposure${server.enabled ? "" : " muted"}`}>
                  {translate(`tools.exposure.${server.exposure}`)}
                </span>
                {!server.enabled && <span className="mcp-disabled-badge">{translate("mcp.disabled")}</span>}
              </div>
            </div>
            <div className="mcp-transport" title={server.source}>{server.transportSummary}</div>
            <dl>
              <div>
                <dt>{translate("mcp.tools")}</dt>
                <dd>{summary?.toolCount ?? server.toolCount}</dd>
              </div>
              <div>
                <dt>{translate("mcp.status")}</dt>
                <dd>{server.connected ? translate("mcp.connected") : translate("mcp.notConnected")}</dd>
              </div>
              <div>
                <dt>{translate("mcp.access")}</dt>
                <dd>{summary?.active ? translate("mcp.declared") : translate("mcp.indirect")}</dd>
              </div>
              <div>
                <dt>{translate("mcp.scope")}</dt>
                <dd>{translate(server.scope === "global" ? "mcp.global" : "mcp.project")}</dd>
              </div>
            </dl>
            <div className="mcp-actions">
              <button
                type="button"
                disabled={pending}
                onClick={() => void update(server, server.enabled
                  ? { action: "disable" }
                  : { action: "enable" })}
              >
                {translate(server.enabled ? "mcp.disable" : "mcp.enable")}
              </button>
              {(["codemode", "deferred", "direct", "hidden"] as const).map((exposure) => (
                <button
                  key={exposure}
                  type="button"
                  disabled={pending || server.exposure === exposure}
                  aria-pressed={server.exposure === exposure}
                  onClick={() => void update(server, { action: "exposure", exposure })}
                >
                  {translate(`tools.exposure.${exposure}`)}
                </button>
              ))}
            </div>
          </article>
          );
        }) : servers ? (
          <div className="mcp-empty">{translate("mcp.empty")}</div>
        ) : (
          <div className="mcp-empty">
            {loading ? translate("mcp.loading") : translate("mcp.load")}
          </div>
        )}
      </div>

      <footer className="mcp-panel-footer">
        <span>{translate("mcp.reloadHint")}</span>
        <button type="button" onClick={() => setReloadKey((key) => key + 1)}>
          {translate("mcp.reload")}
        </button>
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
        .mcp-server-badges,
        .mcp-actions {
          display: flex;
          align-items: center;
          gap: 5px;
        }
        .mcp-exposure.muted,
        .mcp-disabled-badge {
          color: var(--text-dim);
        }
        .mcp-disabled-badge {
          padding: 2px 7px;
          border: 1px solid var(--border);
          border-radius: 999px;
          font-size: 9px;
          font-weight: 750;
          text-transform: uppercase;
        }
        .mcp-transport {
          margin-top: 7px;
          overflow: hidden;
          color: var(--text-dim);
          font-family: var(--font-mono);
          font-size: 10.5px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .mcp-server-card dl {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
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
        .mcp-config-error {
          margin-bottom: 8px;
          padding: 8px 10px;
          border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
          border-radius: 7px;
          color: var(--danger);
          font-size: 11.5px;
          overflow-wrap: anywhere;
        }
        .mcp-actions {
          flex-wrap: wrap;
          margin-top: 11px;
        }
        .mcp-actions button {
          min-height: 25px;
          padding: 3px 8px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-panel);
          color: var(--text-muted);
          font-size: 10px;
          font-weight: 650;
          cursor: pointer;
        }
        .mcp-actions button[aria-pressed="true"] {
          border-color: color-mix(in srgb, var(--accent) 50%, transparent);
          color: var(--accent);
        }
        .mcp-actions button:disabled {
          cursor: default;
          opacity: 0.58;
        }
        .mcp-panel-footer button {
          min-height: 26px;
          padding: 3px 9px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg);
          color: var(--text-muted);
          font-size: 11px;
          cursor: pointer;
        }
        @media (max-width: 640px) {
          .mcp-server-card dl {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
      `}</style>
    </section>
  );
}
