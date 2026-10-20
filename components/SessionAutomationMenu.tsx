"use client";

// Fork-owned: the composer's session (gear) menu — manual compaction plus pi 0.86's
// session automation switches. ChatInput (upstream-owned) keeps the open state and
// ref (its outside-click handler closes every composer menu) and mounts this.

import type { RefObject } from "react";
import type { SessionAutomation, SessionAutomationChange } from "@/hooks/useSessionAutomation";
import { useI18n } from "@/hooks/useI18n";

interface SessionAutomationMenuProps {
  menuRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  onOpenChange: (update: (open: boolean) => boolean) => void;
  /** Anchor the popover to the left edge (mobile) instead of the right. */
  alignLeft: boolean;
  /** Known automation values; undefined while a new session has none yet. */
  automation?: SessionAutomation;
  onSetAutomation?: (change: SessionAutomationChange) => void;
  /** Offered only while a manual compaction can start now. */
  onCompact?: () => void;
}

export function SessionAutomationMenu({
  menuRef, open, onOpenChange, alignLeft, automation, onSetAutomation, onCompact,
}: SessionAutomationMenuProps) {
  const { t } = useI18n();
  return (
    <div ref={menuRef} style={{ position: "relative" }}>
      <button
        className="native-toolbar-button"
        onClick={() => onOpenChange((v) => !v)}
        title={t("chat.sessionAutomation")}
        aria-label={t("chat.sessionAutomation")}
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 32,
          height: 32,
          padding: 0,
          background: open ? "var(--bg-hover)" : "none",
          border: "none", borderRadius: 9,
          color: "var(--text-muted)", cursor: "pointer", fontSize: 12,
          transition: "background 0.12s, color 0.12s",
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open && (
        <div className="native-popover app-menu" style={{
          position: "absolute",
          bottom: "calc(100% + 6px)",
          ...(alignLeft ? { left: 0 } : { right: 0 }),
          zIndex: 100, background: "var(--bg)", border: "var(--hairline) solid var(--border)",
          borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
          padding: "6px 0", minWidth: 230,
        }}>
          {onCompact && (
            <div>
              <button
                type="button"
                className="composer-menu-row"
                title={t("chat.compactContext")}
                onClick={() => {
                  onOpenChange(() => false);
                  onCompact();
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
                  <line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" />
                </svg>
                <span style={{ flex: 1 }}>{t("chat.compactContext")}</span>
              </button>
            </div>
          )}
          {onCompact && automation && (
            <div style={{ height: 0, margin: "5px 0", borderTop: "var(--hairline) solid var(--separator)" }} />
          )}
          {onSetAutomation && automation && (<>
          {automation.autoCompactionEnabled !== null && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={automation.autoCompactionEnabled}
                onChange={(e) => onSetAutomation({ autoCompaction: e.target.checked })}
              />
              {t("chat.autoCompaction")}
            </label>
          )}
          {automation.autoRetryEnabled !== null && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={automation.autoRetryEnabled}
                onChange={(e) => onSetAutomation({ autoRetry: e.target.checked })}
              />
              {t("chat.autoRetry")}
            </label>
          )}
          {automation.steeringMode !== null && (
            <div style={{ padding: "6px 12px", borderTop: "var(--hairline) solid var(--border)", marginTop: 4, paddingTop: 10 }}>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>{t("chat.steeringMode")}</div>
              <div style={{ display: "flex", gap: 4 }}>
                {(["all", "one-at-a-time"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onSetAutomation({ steeringMode: mode })}
                    style={{
                      flex: 1, height: 26, fontSize: 11,
                      border: "var(--hairline) solid var(--border)", borderRadius: 6,
                      background: automation.steeringMode === mode ? "var(--accent)" : "var(--bg)",
                      color: automation.steeringMode === mode ? "var(--accent-contrast)" : "var(--text-muted)",
                      cursor: "pointer",
                    }}
                  >
                    {t(`chat.queueMode.${mode}`)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {automation.followUpMode !== null && (
            <div style={{ padding: "6px 12px 4px", marginBottom: 2 }}>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>{t("chat.followUpMode")}</div>
              <div style={{ display: "flex", gap: 4 }}>
                {(["all", "one-at-a-time"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onSetAutomation({ followUpMode: mode })}
                    style={{
                      flex: 1, height: 26, fontSize: 11,
                      border: "var(--hairline) solid var(--border)", borderRadius: 6,
                      background: automation.followUpMode === mode ? "var(--accent)" : "var(--bg)",
                      color: automation.followUpMode === mode ? "var(--accent-contrast)" : "var(--text-muted)",
                      cursor: "pointer",
                    }}
                  >
                    {t(`chat.queueMode.${mode}`)}
                  </button>
                ))}
              </div>
            </div>
          )}
          </>)}
        </div>
      )}
    </div>
  );
}
