"use client";

import { useMemo, useState, type ReactNode } from "react";
import { sideChatTitle } from "@/lib/session-family";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo, SubagentSessionStatus } from "@/lib/types";
import { isImeComposing } from "@/lib/ime";

interface Props {
  rootSession: SessionInfo;
  subagents: SessionInfo[];
  selectedSessionId: string;
  runningSessionIds: ReadonlySet<string>;
  onSelectSession: (session: SessionInfo) => void;
  /** C1: side chats with a tab in the open right panel. */
  openSideTabIds?: ReadonlySet<string>;
  /** Opens a side chat's right-panel tab, or closes it when it is the one shown. */
  onToggleSideTab?: (sessionId: string) => void;
  /** Forks the main agent into a side chat and opens its tab; answers the refusal to show, or null. */
  onNewSideChat?: () => Promise<string | null>;
  /** Deletes one side chat and its tab; answers the failure to show, or null. */
  onDeleteSideChat?: (sessionId: string) => Promise<string | null>;
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
  if (status === "completed") return "var(--success)";
  if (status === "failed") return "var(--danger)";
  if (status === "aborted") return "var(--warning)";
  return "var(--text-dim)";
}

function StatusIcon({ status }: { status: SubagentSessionStatus }) {
  if (status === "running" || status === "starting") {
    return (
      <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" />
      </svg>
    );
  }
  if (status === "aborted" || status === "interrupted") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M9 9h6v6H9z" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
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
  sideTitle,
  tabShown = false,
  onToggleTab,
  onNewSideChat,
  newSideChatPending = false,
  onDelete,
}: {
  session: SessionInfo;
  main?: boolean;
  selected: boolean;
  running: boolean;
  actionPending: boolean;
  onSelect: () => void;
  onStop: () => void;
  onSteer: () => void;
  /** C1: set for a side chat row, its name as the tabs show it. */
  sideTitle?: string;
  tabShown?: boolean;
  onToggleTab?: () => void;
  onNewSideChat?: () => void;
  newSideChatPending?: boolean;
  onDelete?: () => void;
}) {
  const { locale, t } = useI18n();
  const side = sideTitle !== undefined;
  const relation = session.relation?.kind === "subagent" ? session.relation : null;
  const status: SubagentSessionStatus = running ? "running" : relation?.status ?? "completed";
  const primary = main ? t("agentSwitcher.main") : side ? sideTitle : relation?.description || sessionTitle(session);
  const secondary = main
    ? sessionTitle(session)
    : `${side ? t("agentSwitcher.sideChat") : relation?.profile ?? t("agentSwitcher.subagent")} · ${formatRelativeTime(session.modified, locale)}`;
  // Steer and Stop are the subagent route's; a side chat is driven from its own tab.
  const controllable = !main && !side && running;

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
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
          </svg>
        ) : side ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a8 8 0 0 1-8 8H5.5a2 2 0 0 1-1.4-3.4A8 8 0 1 1 21 12z" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
          </svg>
        )}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--fs-caption)", fontWeight: selected ? 600 : 500 }} title={primary}>
          {primary}
        </span>
        <span style={{ display: "block", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: "var(--fs-micro)" }} title={secondary}>
          {secondary}
        </span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 6, color: main && !running ? "var(--text-dim)" : statusColor(status), fontSize: "var(--fs-micro)", whiteSpace: "nowrap" }}>
        {(main || side) && !running ? (
          main && selected ? t("agentSwitcher.current") : null
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
              style={{ display: "inline-grid", placeItems: "center", width: 22, height: 22, border: "var(--hairline) solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg)", color: "var(--text-muted)", cursor: actionPending ? "default" : "pointer", padding: 0 }}
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
              style={{ display: "inline-grid", placeItems: "center", width: 22, height: 22, border: "var(--hairline) solid color-mix(in srgb, var(--danger) 40%, transparent)", borderRadius: "var(--radius-sm)", background: "var(--bg)", color: "var(--danger)", cursor: actionPending ? "default" : "pointer", padding: 0 }}
            >
              <StopIcon />
            </button>
          </span>
        )}
        {onNewSideChat && (
          <RowButton title={t("sideChat.new")} disabled={newSideChatPending} onClick={onNewSideChat}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a8 8 0 0 1-8 8H5.5a2 2 0 0 1-1.4-3.4A8 8 0 1 1 21 12z" /><path d="M13 8.5v7M9.5 12h7" />
            </svg>
          </RowButton>
        )}
        {onToggleTab && (
          // Greyed, not gone: the row the main chat shows has no tab (one session, one chat).
          <RowButton
            title={selected ? t("agentSwitcher.openInMainChat") : t(tabShown ? "sideChat.closeTab" : "sideChat.openTab")}
            pressed={tabShown}
            disabled={selected}
            onClick={onToggleTab}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" />
              {tabShown && <path d="M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4z" fill="currentColor" />}
            </svg>
          </RowButton>
        )}
        {onDelete && (
          <RowButton title={t("sidebar.delete")} danger onClick={onDelete}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v7M14 10v7" />
            </svg>
          </RowButton>
        )}
      </span>
    </div>
  );
}

/** A row's trailing action; its click never selects the row. */
function RowButton({ title, pressed, danger, disabled, onClick, children }: {
  title: string;
  pressed?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`agent-row-button${danger ? " is-danger" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </button>
  );
}

export function AgentSessionPanel({ rootSession, subagents, selectedSessionId, runningSessionIds, onSelectSession, openSideTabIds, onToggleSideTab, onNewSideChat, onDeleteSideChat }: Props) {
  const { t } = useI18n();
  const [newSideChatPending, setNewSideChatPending] = useState(false);
  const [sideChatError, setSideChatError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const handleNewSideChat = async () => {
    if (!onNewSideChat) return;
    setNewSideChatPending(true);
    setSideChatError(null);
    try {
      setSideChatError(await onNewSideChat());
    } catch (error) {
      setSideChatError(error instanceof Error ? error.message : String(error));
    } finally {
      setNewSideChatPending(false);
    }
  };
  const handleDeleteSideChat = async (sessionId: string) => {
    setConfirmDeleteId(null);
    if (!onDeleteSideChat) return;
    setSideChatError(null);
    try {
      setSideChatError(await onDeleteSideChat(sessionId));
    } catch (error) {
      setSideChatError(error instanceof Error ? error.message : String(error));
    }
  };
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
        borderRadius: "0 0 var(--radius-sm) var(--radius-sm)",
        boxShadow: "var(--shadow-popover)",
        overflow: "hidden",
      }}
    >
      <div>
        <div style={{ minHeight: 44, display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderBottom: "var(--hairline) solid var(--border)" }}>
          <strong style={{ fontSize: "var(--fs-caption)", fontWeight: "var(--fw-semibold)" }}>{t("agentSwitcher.title")}</strong>
          <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-micro)" }}>
            {t("agentSwitcher.count", { count: subagents.length })}
          </span>
          {runningCount > 0 && (
            <span style={{ marginLeft: "auto", color: "var(--accent)", fontSize: "var(--fs-micro)" }}>
              {t("agentSwitcher.runningCount", { count: runningCount })}
            </span>
          )}
        </div>
        {sideChatError && (
          <div role="alert" style={{ padding: "6px 12px", background: "color-mix(in srgb, var(--danger) 7%, transparent)", color: "var(--danger)", fontSize: "var(--fs-micro)", borderBottom: "var(--hairline) solid var(--border)" }}>
            {sideChatError}
          </div>
        )}
        {controlError && (
          <div role="alert" style={{ padding: "6px 12px", background: "color-mix(in srgb, var(--danger) 7%, transparent)", color: "var(--danger)", fontSize: "var(--fs-micro)", borderBottom: "var(--hairline) solid var(--border)" }}>
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
                border: "var(--hairline) solid var(--border)", borderRadius: "var(--radius-sm)",
                background: "var(--bg)", color: "var(--text)", fontSize: "var(--fs-caption)", outline: "none",
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
            onNewSideChat={onNewSideChat ? () => void handleNewSideChat() : undefined}
            newSideChatPending={newSideChatPending}
          />
          {visibleSubagents.map((session) => (
            <div key={session.id}>
              <AgentRow
                session={session}
                selected={session.id === selectedSessionId}
                running={runningSessionIds.has(session.id)}
                actionPending={actionPendingId === session.id}
                onSelect={() => onSelectSession(session)}
                sideTitle={session.relation?.kind === "side" ? sideChatTitle(session, t("agentSwitcher.sideChat"), subagents) : undefined}
                tabShown={openSideTabIds?.has(session.id) ?? false}
                onToggleTab={session.relation?.kind === "side" && onToggleSideTab ? () => onToggleSideTab(session.id) : undefined}
                onDelete={session.relation?.kind === "side" && onDeleteSideChat ? () => setConfirmDeleteId(session.id) : undefined}
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
              {confirmDeleteId === session.id && (
                <div role="alertdialog" aria-label={t("sidebar.delete")} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderBottom: "var(--hairline) solid var(--border)", background: "var(--bg)" }}>
                  <span style={{ flex: 1, minWidth: 0, color: "var(--text-muted)", fontSize: "var(--fs-caption)" }}>{t("sidebar.deleteChatBody")}</span>
                  <button type="button" className="agent-row-confirm" onClick={() => setConfirmDeleteId(null)}>{t("sidebar.cancel")}</button>
                  <button type="button" className="agent-row-confirm is-danger" onClick={() => void handleDeleteSideChat(session.id)}>{t("sidebar.delete")}</button>
                </div>
              )}
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
                    style={{ flex: 1, minWidth: 0, height: 30, padding: "0 10px", border: "var(--hairline) solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg)", color: "var(--text)", fontSize: "var(--fs-caption)", outline: "none" }}
                  />
                  <button
                    type="button"
                    disabled={!steerDraft.trim() || actionPendingId === session.id}
                    onClick={() => void submitSteer(session.id)}
                    style={{ height: 30, padding: "0 12px", border: "none", borderRadius: "var(--radius-sm)", background: "var(--accent)", color: "var(--accent-contrast)", fontSize: "var(--fs-caption)", cursor: !steerDraft.trim() || actionPendingId === session.id ? "default" : "pointer" }}
                  >
                    {t("agentSwitcher.steerSend")}
                  </button>
                </div>
              )}
            </div>
          ))}
          {visibleSubagents.length === 0 && (
            <div style={{ padding: "22px 12px", color: "var(--text-dim)", fontSize: "var(--fs-caption)", textAlign: "center" }}>
              {subagents.length === 0 ? t("agentSwitcher.none") : t("agentSwitcher.noMatches")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
