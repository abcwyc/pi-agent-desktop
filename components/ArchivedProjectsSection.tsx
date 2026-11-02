"use client";

// Fork-owned: the Archive group at the bottom of the sidebar's project list.
// Its header folds like the Chats section (folded by default, see
// lib/archived-projects.ts); the project rows inside are rendered by
// SessionSidebar (upstream-owned), which passes them in as children.

import type { ReactNode } from "react";
import type { TranslationParams } from "@/lib/i18n/types";

interface Props {
  count: number;
  expanded: boolean;
  runningCount: number;
  unreadCount: number;
  onToggle: () => void;
  t: (key: string, params?: TranslationParams) => string;
  children: ReactNode;
}

export function ArchivedProjectsSection({ count, expanded, runningCount, unreadCount, onToggle, t, children }: Props) {
  return (
    <div className="sidebar-archive-section">
      <div className="sidebar-project-tree-header sidebar-chats-header sidebar-archive-header">
        <button
          type="button"
          className="sidebar-chats-title"
          data-sidebar-tree-row
          aria-expanded={expanded}
          title={t(expanded ? "sidebar.collapseArchive" : "sidebar.expandArchive")}
          onClick={onToggle}
        >
          <span className="sidebar-project-tree-title">{t("sidebar.archive")}</span>
          <span className="sidebar-project-tree-count">({count})</span>
          {/* Folded, the header is the only place a running or unread session
              inside the archive can still be seen. */}
          {!expanded && (
            <span className="sidebar-project-tree-meta">
              {runningCount > 0 && (
                <span className="sidebar-project-tree-chip is-running" title={t("sidebar.runningCount", { count: runningCount })}>
                  {runningCount}
                </span>
              )}
              {unreadCount > 0 && (
                <span className="sidebar-project-tree-chip is-unread" title={t("sidebar.unreadCount", { count: unreadCount })}>
                  {unreadCount}
                </span>
              )}
            </span>
          )}
        </button>
      </div>
      {expanded && <div className="sidebar-archive-projects">{children}</div>}
    </div>
  );
}
