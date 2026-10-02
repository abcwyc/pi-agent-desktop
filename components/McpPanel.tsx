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

const EXPOSURES: readonly McpExposure[] = ["codemode", "deferred", "direct", "hidden"];

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

function displayTransport(server: McpServer): string {
  return server.transport === "http" ? redactUrl(server.transportSummary) : server.transportSummary;
}

function statusKind(server: McpServer): "disabled" | "connected" | "idle" {
  if (!server.enabled) return "disabled";
  return server.connected ? "connected" : "idle";
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
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [pendingServer, setPendingServer] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    if (!cwd) {
      setServers(null);
      return;
    }
    try {
      const query = new URLSearchParams({ cwd });
      if (sessionId) query.set("sessionId", sessionId);
      const response = await fetch(`/api/mcp?${query.toString()}`);
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

  useEffect(() => {
    setSelectedName((current) => {
      if (servers?.some((server) => server.name === current)) return current;
      return servers?.[0]?.name ?? null;
    });
  }, [servers]);

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
  const selected = servers?.find((server) => server.name === selectedName) ?? null;
  const selectedSummary = selected
    ? liveSummaries.find((item) => item.name === selected.name)
    : undefined;
  const connectedCount = servers?.filter((server) => server.connected).length ?? 0;
  const totalTools = servers?.reduce((sum, server) => sum + server.toolCount, 0) ?? 0;

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
              : loading ? translate("mcp.loading") : translate("mcp.load")}
          </p>
        </div>
        <button type="button" onClick={() => setReloadKey((key) => key + 1)}>
          {translate("mcp.reload")}
        </button>
      </header>

      {(requestError || configErrors.length > 0) && (
        <div className="mcp-alerts">
          {requestError && <div>{requestError}</div>}
          {configErrors.map((error) => <div key={error}>{error}</div>)}
        </div>
      )}

      <div className="mcp-workbench">
        <div className="mcp-list" role="listbox" aria-label={translate("mcp.serverList")} tabIndex={0}>
          {servers?.length ? servers.map((server) => {
            const status = statusKind(server);
            const selectedRow = server.name === selected?.name;
            return (
              <button
                key={server.name}
                type="button"
                role="option"
                aria-selected={selectedRow}
                className={`mcp-row${selectedRow ? " selected" : ""}`}
                onClick={() => setSelectedName(server.name)}
              >
                <span className={`mcp-dot status-${status}`} aria-hidden="true" />
                <span className="mcp-row-main">
                  <span className="mcp-row-name">{server.name}</span>
                  <span className="mcp-row-meta">
                    {server.toolCount} {translate("mcp.toolsUnit")}
                    {!server.enabled && ` · ${translate("mcp.disabled")}`}
                  </span>
                </span>
                <span className="mcp-row-exposure">
                  {translate(`tools.exposure.${server.exposure}`)}
                </span>
              </button>
            );
          }) : servers ? (
            <div className="mcp-empty">{translate("mcp.empty")}</div>
          ) : (
            <div className="mcp-empty">
              {loading ? translate("mcp.loading") : translate("mcp.load")}
            </div>
          )}
        </div>

        <div className="mcp-detail">
          {selected ? (() => {
            const pending = pendingServer === selected.name;
            return (
              <>
                <div className="mcp-detail-title">
                  <div>
                    <h3>{selected.name}</h3>
                    <p>{displayTransport(selected)}</p>
                  </div>
                  <span className={`mcp-state status-${statusKind(selected)}`}>
                    {translate(selected.connected ? "mcp.connected" : selected.enabled ? "mcp.notConnected" : "mcp.disabled")}
                  </span>
                </div>

                <dl className="mcp-facts">
                  <div>
                    <dt>{translate("mcp.tools")}</dt>
                    <dd>{selectedSummary?.toolCount ?? selected.toolCount}</dd>
                  </div>
                  <div>
                    <dt>{translate("mcp.access")}</dt>
                    <dd>{selectedSummary?.active ? translate("mcp.declared") : translate("mcp.indirect")}</dd>
                  </div>
                  <div>
                    <dt>{translate("mcp.scope")}</dt>
                    <dd>{translate(selected.scope === "global" ? "mcp.global" : "mcp.project")}</dd>
                  </div>
                  <div>
                    <dt>{translate("tools.availability")}</dt>
                    <dd>{translate(`tools.exposure.${selected.exposure}`)}</dd>
                  </div>
                </dl>

                <div className="mcp-control-group">
                  <div className="mcp-control-label">{translate("mcp.power")}</div>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => void update(selected, selected.enabled
                      ? { action: "disable" }
                      : { action: "enable" })}
                  >
                    {translate(selected.enabled ? "mcp.disable" : "mcp.enable")}
                  </button>
                </div>

                <div className="mcp-control-group">
                  <div className="mcp-control-label">{translate("mcp.exposure")}</div>
                  <div className="mcp-segmented">
                    {EXPOSURES.map((exposure) => (
                      <button
                        key={exposure}
                        type="button"
                        disabled={pending || selected.exposure === exposure}
                        aria-pressed={selected.exposure === exposure}
                        onClick={() => void update(selected, { action: "exposure", exposure })}
                      >
                        {translate(`tools.exposure.${exposure}`)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mcp-config-path" title={selected.source}>
                  {selected.source}
                </div>
              </>
            );
          })() : (
            <div className="mcp-empty">{translate("mcp.selectServer")}</div>
          )}
        </div>
      </div>

      <footer className="mcp-panel-footer">
        {translate("mcp.reloadHint")}
      </footer>

      <style>{`
        .mcp-panel {
          display: flex;
          height: min(560px, 72dvh);
          min-height: 280px;
          flex-direction: column;
          overflow: hidden;
          background: var(--bg-panel);
          border-bottom: 1px solid var(--border);
        }
        .mcp-panel-header {
          display: flex;
          flex-shrink: 0;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          padding: 14px 18px;
          border-bottom: 1px solid var(--border);
          background:
            radial-gradient(120% 130% at 0% 0%, color-mix(in srgb, var(--accent) 15%, transparent), transparent 62%),
            var(--bg-panel);
        }
        .mcp-panel-header h2 {
          margin: 0;
          color: var(--text);
          font-family: var(--font-display);
          font-size: 15px;
          font-weight: 780;
          letter-spacing: -0.01em;
        }
        .mcp-panel-header p {
          margin: 3px 0 0;
          color: var(--text-muted);
          font-size: 11.5px;
        }
        .mcp-panel-header > button,
        .mcp-control-group > button {
          min-height: 27px;
          padding: 4px 10px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: color-mix(in srgb, var(--bg) 78%, var(--bg-panel));
          color: var(--text-muted);
          font-size: 11px;
          font-weight: 650;
          cursor: pointer;
        }
        .mcp-panel-header > button:hover,
        .mcp-control-group > button:hover:not(:disabled) {
          border-color: color-mix(in srgb, var(--accent) 45%, transparent);
          color: var(--text);
        }
        .mcp-alerts {
          display: grid;
          gap: 6px;
          padding: 10px 18px;
          border-bottom: 1px solid color-mix(in srgb, var(--danger) 26%, var(--border));
          background: color-mix(in srgb, var(--danger) 7%, var(--bg-panel));
          color: var(--danger);
          font-size: 11.5px;
          overflow-wrap: anywhere;
        }
        .mcp-workbench {
          display: grid;
          min-height: 0;
          flex: 1;
          grid-template-columns: minmax(180px, 31%) minmax(0, 1fr);
        }
        .mcp-list {
          min-height: 0;
          overflow: auto;
          border-right: 1px solid var(--border);
          background: color-mix(in srgb, var(--bg) 55%, var(--bg-panel));
          padding: 7px;
        }
        .mcp-row {
          display: grid;
          width: 100%;
          min-height: 43px;
          grid-template-columns: 8px minmax(0, 1fr) auto;
          align-items: center;
          gap: 9px;
          margin-bottom: 3px;
          padding: 7px 8px;
          border: 1px solid transparent;
          border-radius: 7px;
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          text-align: left;
        }
        .mcp-row:hover {
          background: var(--bg-hover);
          color: var(--text);
        }
        .mcp-row.selected {
          border-color: color-mix(in srgb, var(--accent) 32%, transparent);
          background: color-mix(in srgb, var(--accent) 11%, var(--bg-panel));
          color: var(--text);
        }
        .mcp-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--text-dim);
          box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 12%, transparent);
        }
        .mcp-dot.status-connected {
          background: #22c55e;
        }
        .mcp-dot.status-disabled {
          background: var(--text-dim);
        }
        .mcp-dot.status-idle {
          background: #f59e0b;
        }
        .mcp-row-main {
          min-width: 0;
        }
        .mcp-row-name {
          display: block;
          overflow: hidden;
          color: inherit;
          font-size: 12px;
          font-weight: 680;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .mcp-row-meta {
          display: block;
          margin-top: 2px;
          color: var(--text-dim);
          font-size: 10px;
        }
        .mcp-row-exposure {
          max-width: 52px;
          overflow: hidden;
          color: var(--text-dim);
          font-size: 9px;
          font-weight: 700;
          text-transform: uppercase;
          text-overflow: ellipsis;
        }
        .mcp-detail {
          min-height: 0;
          overflow: auto;
          padding: 17px 18px 20px;
        }
        .mcp-detail-title {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 14px;
        }
        .mcp-detail-title h3 {
          margin: 0;
          color: var(--text);
          font-family: var(--font-display);
          font-size: 17px;
          font-weight: 780;
          letter-spacing: -0.015em;
        }
        .mcp-detail-title p {
          margin: 5px 0 0;
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 10.5px;
          overflow-wrap: anywhere;
        }
        .mcp-state {
          flex-shrink: 0;
          padding: 3px 8px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 720;
        }
        .mcp-state.status-connected {
          color: #15803d;
          background: color-mix(in srgb, #22c55e 15%, transparent);
        }
        .mcp-state.status-idle {
          color: #b45309;
          background: color-mix(in srgb, #f59e0b 15%, transparent);
        }
        .mcp-state.status-disabled {
          color: var(--text-dim);
          background: var(--bg-hover);
        }
        .mcp-facts {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 1px;
          margin: 18px 0 0;
          border: 1px solid var(--border);
          border-radius: 8px;
          overflow: hidden;
          background: var(--border);
        }
        .mcp-facts > div {
          min-width: 0;
          padding: 10px 11px;
          background: color-mix(in srgb, var(--bg) 82%, var(--bg-panel));
        }
        .mcp-facts dt {
          color: var(--text-dim);
          font-size: 9.5px;
          font-weight: 720;
          text-transform: uppercase;
        }
        .mcp-facts dd {
          margin: 4px 0 0;
          color: var(--text);
          font-size: 12px;
          overflow-wrap: anywhere;
        }
        .mcp-control-group {
          margin-top: 17px;
        }
        .mcp-control-label {
          margin-bottom: 7px;
          color: var(--text-dim);
          font-size: 10px;
          font-weight: 720;
          text-transform: uppercase;
        }
        .mcp-control-group > button:disabled {
          cursor: default;
          opacity: 0.55;
        }
        .mcp-segmented {
          display: inline-grid;
          max-width: 100%;
          grid-template-columns: repeat(4, minmax(62px, 1fr));
          gap: 2px;
          padding: 2px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: color-mix(in srgb, var(--bg) 72%, var(--bg-panel));
        }
        .mcp-segmented button {
          min-height: 28px;
          padding: 4px 8px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--text-dim);
          font-size: 11px;
          font-weight: 650;
          cursor: pointer;
        }
        .mcp-segmented button[aria-pressed="true"] {
          background: color-mix(in srgb, var(--accent) 16%, var(--bg-panel));
          color: var(--accent);
        }
        .mcp-segmented button:disabled {
          cursor: default;
        }
        .mcp-config-path {
          margin-top: 20px;
          padding-top: 12px;
          border-top: 1px dashed var(--border);
          color: var(--text-dim);
          font-family: var(--font-mono);
          font-size: 10px;
          overflow-wrap: anywhere;
        }
        .mcp-empty {
          padding: 16px 12px;
          color: var(--text-muted);
          font-size: 12px;
          font-style: italic;
        }
        .mcp-panel-footer {
          flex-shrink: 0;
          padding: 9px 18px;
          border-top: 1px solid var(--border);
          background: color-mix(in srgb, var(--bg) 60%, var(--bg-panel));
          color: var(--text-muted);
          font-size: 11px;
        }
        @media (max-width: 760px) {
          .mcp-workbench {
            grid-template-columns: 1fr;
            grid-template-rows: auto minmax(0, 1fr);
          }
          .mcp-list {
            max-height: 170px;
            border-right: 0;
            border-bottom: 1px solid var(--border);
          }
          .mcp-facts {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .mcp-segmented {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            width: 100%;
          }
        }
      `}</style>
    </section>
  );
}
