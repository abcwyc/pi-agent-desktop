"use client";

// Fork-owned: the `#` session-mention menu above the composer. State lives in
// hooks/useSessionMentionPalette.ts; ChatInput (upstream-owned) only mounts this.

import type { MutableRefObject } from "react";
import type { SessionMentionEntry } from "@/lib/file-fuzzy";
import { useI18n } from "@/hooks/useI18n";

interface SessionMentionMenuProps {
  /** False until the session index has been fetched once. */
  loaded: boolean;
  matches: SessionMentionEntry[];
  activeIndex: number;
  itemRefs: MutableRefObject<Array<HTMLButtonElement | null>>;
  onPick: (entry: SessionMentionEntry) => void;
  onHover: (index: number) => void;
}

export function SessionMentionMenu({ loaded, matches, activeIndex, itemRefs, onPick, onHover }: SessionMentionMenuProps) {
  const { t } = useI18n();
  const matchCountLabel = matches.length === 1 ? t("chat.match") : t("chat.matches", { count: matches.length });
  return (
    <div
      className="native-popover app-menu app-suggestion-menu"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "calc(100% + 8px)",
        zIndex: 121,
        background: "var(--bg)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
        overflow: "hidden",
        maxHeight: "min(48vh, 400px)",
      }}
    >
      <div style={{
        padding: "8px 10px",
        borderBottom: "var(--hairline) solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        fontSize: 11,
        color: "var(--text-dim)",
      }}>
        <span>{loaded ? t("chat.sessions", { label: matchCountLabel }) : t("chat.loadingSessions")}</span>
        <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
      </div>
      <div style={{ maxHeight: "calc(min(48vh, 400px) - 34px)", overflowY: "auto", padding: 4 }}>
        {!loaded ? (
          <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>{t("chat.loadingSessions")}</div>
        ) : matches.length === 0 ? (
          <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>{t("chat.noMatchingSessions")}</div>
        ) : matches.map((entry, index) => {
          const active = index === activeIndex;
          const name = entry.name?.trim() || entry.firstMessage.trim() || t("chat.untitledSession");
          return (
            <button
              key={`session:${entry.id}`}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(entry);
              }}
              onMouseEnter={() => onHover(index)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 8px",
                border: "none",
                borderRadius: 6,
                background: active ? "var(--bg-selected)" : "none",
                color: "var(--text)",
                cursor: "pointer",
                textAlign: "left",
                fontSize: 13,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
              </svg>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                <span style={{ display: "block", color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.firstMessage}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
