import { useCallback, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import type { ContextUsage, SessionStatsInfo } from "@/lib/pi-types";

export type SessionCopyField = "file" | "id";

interface SessionStatsPanelProps {
  sessionStats: SessionStatsInfo | null;
  contextUsage?: ContextUsage | null;
  isMobile: boolean;
}

/**
 * Reusable session-stats detail panel. Shared between the top-bar More →
 * Session Stats entry (AppShell) and the context-usage ring popover next to
 * the model selector (ChatInput). Copy feedback state is self-contained so
 * both call sites behave independently.
 */
export function SessionStatsPanel({ sessionStats, contextUsage, isMobile }: SessionStatsPanelProps) {
  const { locale, t: translate } = useI18n();
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  return (
    <div className="session-info-popover" style={{
      background: "var(--surface-elevated)",
      borderBottom: "1px solid var(--border)",
      boxShadow: "var(--shadow-popover)",
      padding: "12px 16px",
    }}>
      {sessionStats ? (() => {
        const sessionRows = [
          ...(sessionStats.sessionName ? [{ label: translate("session.name"), value: sessionStats.sessionName, copyField: null }] : []),
          { label: translate("session.file"), value: sessionStats.sessionFile ?? translate("session.inMemory"), copyField: "file" as const },
          { label: translate("session.id"), value: sessionStats.sessionId, copyField: "id" as const },
        ];
        const messageRows = [
          [translate("session.user"), sessionStats.userMessages.toLocaleString(locale)],
          [translate("session.assistant"), sessionStats.assistantMessages.toLocaleString(locale)],
          [translate("session.toolCalls"), sessionStats.toolCalls.toLocaleString(locale)],
          [translate("session.toolResults"), sessionStats.toolResults.toLocaleString(locale)],
          [translate("session.total"), sessionStats.totalMessages.toLocaleString(locale)],
        ];
        const tokenRows = [
          [translate("session.input"), sessionStats.tokens.input.toLocaleString(locale)],
          [translate("session.output"), sessionStats.tokens.output.toLocaleString(locale)],
          ...(sessionStats.tokens.cacheRead > 0 ? [[translate("session.cacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)]] : []),
          ...(sessionStats.tokens.cacheWrite > 0 ? [[translate("session.cacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString(locale)]] : []),
          [translate("session.total"), sessionStats.tokens.total.toLocaleString(locale)],
        ];
        const ctx = contextUsage ?? sessionStats.contextUsage;
        const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
        const extraTokenRows = [
          ...(sessionStats.cost > 0 ? [[translate("session.cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
          ...(ctx?.contextWindow ? [[translate("session.context"), `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`]] : []),
        ];
        const section = (
          title: string,
          sectionRows: string[][],
          valueAlign: "left" | "right" = "left",
          compact = false,
        ) => (
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
              <div style={{
                display: "grid",
                gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                columnGap: compact ? 14 : 12,
                rowGap: 4,
                justifyContent: compact ? "start" : undefined,
              }}>
                {sectionRows.map(([label, value]) => (
                  <div key={`${title}:${label}`} style={{ display: "contents" }}>
                    <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                    <div style={{
                      color: "var(--text-muted)",
                      minWidth: 0,
                      overflowWrap: compact ? "normal" : "anywhere",
                      textAlign: valueAlign,
                      whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                    }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        const copyButton = (field: SessionCopyField, value: string) => {
          const copied = copiedSessionField === field;
          return (
            <button
              type="button"
              title={copied ? translate("session.copied") : translate(field === "file" ? "session.copyFile" : "session.copyId")}
              onClick={() => handleCopySessionField(field, value)}
              style={{
                alignSelf: "start",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                marginTop: -2,
                color: copied ? "var(--accent)" : "var(--text-dim)",
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: 4,
                cursor: "pointer",
                flex: "0 0 auto",
                transition: "color 0.12s, border-color 0.12s, background 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "var(--accent)";
                e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                e.currentTarget.style.borderColor = "var(--border)";
                e.currentTarget.style.background = "transparent";
              }}
            >
              {copied ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          );
        };
        const sessionInfoSection = (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
              {sessionRows.map((row) => (
                <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                  <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                  <div style={{
                    color: "var(--text-muted)",
                    minWidth: 0,
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                    whiteSpace: "normal",
                  }}>{row.value}</div>
                  <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                </div>
              ))}
            </div>
          </div>
        );

        return (
          <div style={{
            display: "grid",
            gridTemplateColumns: isMobile
              ? "1fr"
              : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
            gap: isMobile ? 16 : 24,
            fontSize: 12,
            lineHeight: 1.5,
            fontFamily: "var(--font-mono)",
          }}>
            {sessionInfoSection}
            {section(translate("session.messages"), messageRows)}
            {section(translate("session.tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
          </div>
        );
      })() : (
        <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
          {translate("session.load")}
        </div>
      )}
    </div>
  );
}
