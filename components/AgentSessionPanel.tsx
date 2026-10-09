"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo, SubagentSessionStatus } from "@/lib/types";
import { isImeComposing } from "@/lib/ime";

interface Props {
  rootSession: SessionInfo;
  subagents: SessionInfo[];
  selectedSessionId: string;
  runningSessionIds: ReadonlySet<string>;
  onSelectSession: (session: SessionInfo) => void;
}

function sessionTitle(session: SessionInfo): string {
  return session.name || session.firstMessage || session.id.slice(0, 12);
}

function formatRelativeTime(value: string, locale: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const elapsedSeconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(elapsedSeconds) < 60) return formatter.format(elapsedSeconds, "second");
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (Math.abs(elapsedMinutes) < 60) return formatter.format(elapsedMinutes, "minute");
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (Math.abs(elapsedHours) < 24) return formatter.format(elapsedHours, "hour");
  return formatter.format(Math.round(elapsedHours / 24), "day");
}

function statusColor(status: SubagentSessionStatus): string {
  if (status === "running" || status === "starting") return "var(--accent)";
  if (status === "completed") return "#16a34a";
  if (status === "failed") return "#dc2626";
  if (status === "aborted") return "#d97706";
  return "var(--text-dim)";
}

function StatusIcon({ status }: { status: SubagentSessionStatus }) {
  if (status === "running" || status === "starting") {
    return (
      <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" />
      </svg>
    );
  }
  if (status === "aborted" || status === "interrupted") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M9 9h6v6H9z" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
      <rect x="2" y="2" width="6" height="6" rx="1" />
    </svg>
  );
}

function SteerIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function AgentRow({
  session,
  main,
  selected,
  running,
  actionPending,
  onSelect,
  onStop,
  onSteer,
}: {
  session: SessionInfo;
  main?: boolean;
  selected: boolean;
  running: boolean;
  actionPending: boolean;
  onSelect: () => void;
  onStop: () => void;
  onSteer: () => void;
}) {
  const { locale, t } = useI18n();
  const relation = session.relation?.kind === "subagent" ? session.relation : null;
  const status: SubagentSessionStatus = running ? "running" : relation?.status ?? "completed";
  const primary = main ? t("agentSwitcher.main") : relation?.description || sessionTitle(session);
  const secondary = main
    ? sessionTitle(session)
    : `${relation?.profile ?? t("agentSwitcher.subagent")} · ${formatRelativeTime(session.modified, locale)}`;
  const controllable = !main && running;

  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      style={{
        width: "100%",
        minHeight: 56,
        display: "grid",
        gridTemplateColumns: "28px minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 9,
        padding: "7px 12px",
        borderBottom: "var(--hairline) solid var(--border)",
        borderLeft: selected ? "2px solid var(--accent)" : "2px solid transparent",
        background: selected ? "var(--bg-selected)" : "transparent",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
      }}
      onMouseEnter={(event) => {
        if (!selected) event.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(event) => {
        if (!selected) event.currentTarget.style.background = "transparent";
      }}
    >
      <span style={{ width: 28, height: 28, display: "grid", placeItems: "center", color: main ? "var(--text-muted)" : "var(--accent)" }}>
        {main ? (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
          </svg>
        ) : (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
          </svg>
        )}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: selected ? 600 : 500 }} title={primary}>
          {primary}
        </span>
        <span style={{ display: "block", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 11 }} title={secondary}>
          {secondary}
        </span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 6, color: main && !running ? "var(--text-dim)" : statusColor(status), fontSize: 11, whiteSpace: "nowrap" }}>
        {main && !running ? (
          selected ? t("agentSwitcher.current") : null
        ) : (
          <>
            <StatusIcon status={status} />
            <span>{t(`agentSwitcher.status.${status}`)}</span>
          </>
        )}
        {controllable && (
          <span style={{ display: "inline-flex", gap: 4, marginLeft: 4 }}>
            <button
              type="button"
              title={t("agentSwitcher.steer")}
              aria-label={t("agentSwitcher.steer")}
              disabled={actionPending}
              onClick={(event) => {
                event.stopPropagation();
                onSteer();
              }}
              style={{ display: "inline-grid", placeItems: "center", width: 22, height: 22, border: "var(--hairline) solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text-muted)", cursor: actionPending ? "default" : "pointer", padding: 0 }}
            >
              <SteerIcon />
            </button>
            <button
              type="button"
              title={t("agentSwitcher.stop")}
              aria-label={t("agentSwitcher.stop")}
              disabled={actionPending}
              onClick={(event) => {
                event.stopPropagation();
                onStop();
              }}
              style={{ display: "inline-grid", placeItems: "center", width: 22, height: 22, border: "var(--hairline) solid rgba(239,68,68,0.4)", borderRadius: 5, background: "var(--bg)", color: "#ef4444", cursor: actionPending ? "default" : "pointer", padding: 0 }}
            >
              <StopIcon />
            </button>
          </span>
        )}
      </span>
    </div>
  );
}

export function AgentSessionPanel({ rootSession, subagents, selectedSessionId, runningSessionIds, onSelectSession }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [steerOpenId, setSteerOpenId] = useState<string | null>(null);
  const [steerDraft, setSteerDraft] = useState("");
  const [actionPendingId, setActionPendingId] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);

  const sortedSubagents = useMemo(() => [...subagents].sort((a, b) => {
    const aRunning = runningSessionIds.has(a.id);
    const bRunning = runningSessionIds.has(b.id);
    if (aRunning !== bRunning) return aRunning ? -1 : 1;
    return b.modified.localeCompare(a.modified);
  }), [runningSessionIds, subagents]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleSubagents = normalizedQuery
    ? sortedSubagents.filter((session) => {
      const relation = session.relation?.kind === "subagent" ? session.relation : null;
      return [relation?.description, relation?.profile, session.name, session.firstMessage]
        .some((value) => value?.toLowerCase().includes(normalizedQuery));
    })
    : sortedSubagents;
  const runningCount = subagents.filter((session) => runningSessionIds.has(session.id)).length;

  async function controlSubagent(id: string, action: "abort" | "steer", message?: string): Promise<boolean> {
    setControlError(null);
    setActionPendingId(id);
    try {
      const res = await fetch(`/api/subagents/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, message }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      return true;
    } catch (e) {
      setControlError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setActionPendingId(null);
    }
  }

  async function submitSteer(id: string) {
    const message = steerDraft.trim();
    if (!message) return;
    if (await controlSubagent(id, "steer", message)) {
      setSteerOpenId(null);
      setSteerDraft("");
    }
  }

  return (
    <div
      className="agent-session-panel"
      role="listbox"
      aria-label={t("agentSwitcher.title")}
      style={{
        background: "var(--bg-panel)",
        borderLeft: "var(--hairline) solid var(--border)",
        borderRight: "var(--hairline) solid var(--border)",
        borderBottom: "var(--hairline) solid var(--border)",
        borderRadius: "0 0 6px 6px",
        boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
        overflow: "hidden",
      }}
    >
      <div>
        <div style={{ minHeight: 44, display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderBottom: "var(--hairline) solid var(--border)" }}>
          <strong style={{ fontSize: 12, fontWeight: 600 }}>{t("agentSwitcher.title")}</strong>
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
            {t("agentSwitcher.count", { count: subagents.length })}
          </span>
          {runningCount > 0 && (
            <span style={{ marginLeft: "auto", color: "var(--accent)", fontSize: 11 }}>
              {t("agentSwitcher.runningCount", { count: runningCount })}
            </span>
          )}
        </div>
        {controlError && (
          <div role="alert" style={{ padding: "6px 12px", background: "rgba(239,68,68,0.07)", color: "#ef4444", fontSize: 11, borderBottom: "var(--hairline) solid var(--border)" }}>
            {controlError}
          </div>
        )}
        {subagents.length > 8 && (
          <div style={{ padding: 8, borderBottom: "var(--hairline) solid var(--border)" }}>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("agentSwitcher.search")}
              aria-label={t("agentSwitcher.search")}
              style={{
                width: "100%", height: 32, padding: "0 10px",
                border: "var(--hairline) solid var(--border)", borderRadius: 6,
                background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
              }}
            />
          </div>
        )}
        <div style={{ maxHeight: "min(58dvh, 480px)", overflowY: "auto" }}>
          <AgentRow
            session={rootSession}
            main
            selected={rootSession.id === selectedSessionId}
            running={runningSessionIds.has(rootSession.id)}
            actionPending={actionPendingId === rootSession.id}
            onSelect={() => onSelectSession(rootSession)}
            onStop={() => {}}
            onSteer={() => {}}
          />
          {visibleSubagents.map((session) => (
            <div key={session.id}>
              <AgentRow
                session={session}
                selected={session.id === selectedSessionId}
                running={runningSessionIds.has(session.id)}
                actionPending={actionPendingId === session.id}
                onSelect={() => onSelectSession(session)}
                onStop={() => {
                  setSteerOpenId(null);
                  void controlSubagent(session.id, "abort");
                }}
                onSteer={() => {
                  setControlError(null);
                  setSteerDraft("");
                  setSteerOpenId((current) => current === session.id ? null : session.id);
                }}
              />
              {steerOpenId === session.id && runningSessionIds.has(session.id) && (
                <div style={{ display: "flex", gap: 6, padding: "6px 12px", borderBottom: "var(--hairline) solid var(--border)", background: "var(--bg)" }}>
                  <input
                    autoFocus
                    type="text"
                    value={steerDraft}
                    onChange={(event) => setSteerDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (isImeComposing(event)) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void submitSteer(session.id);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setSteerOpenId(null);
                      }
                    }}
                    placeholder={t("agentSwitcher.steerPlaceholder")}
                    aria-label={t("agentSwitcher.steer")}
                    style={{ flex: 1, minWidth: 0, height: 30, padding: "0 10px", border: "var(--hairline) solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none" }}
                  />
                  <button
                    type="button"
                    disabled={!steerDraft.trim() || actionPendingId === session.id}
                    onClick={() => void submitSteer(session.id)}
                    style={{ height: 30, padding: "0 12px", border: "none", borderRadius: 6, background: "var(--accent)", color: "#fff", fontSize: 12, cursor: !steerDraft.trim() || actionPendingId === session.id ? "default" : "pointer" }}
                  >
                    {t("agentSwitcher.steerSend")}
                  </button>
                </div>
              )}
            </div>
          ))}
          {visibleSubagents.length === 0 && (
            <div style={{ padding: "22px 12px", color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
              {subagents.length === 0 ? t("agentSwitcher.none") : t("agentSwitcher.noMatches")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
