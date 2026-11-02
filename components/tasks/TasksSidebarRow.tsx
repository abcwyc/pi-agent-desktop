"use client";

import { useI18n } from "@/hooks/useI18n";

interface Props {
  active: boolean;
  runningCount: number;
  onOpen: () => void;
}

/** The Tasks entry under New Session: opens the live overview, counts running sessions. */
export function TasksSidebarRow({ active, runningCount, onOpen }: Props) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={`sidebar-header-row sidebar-scheduled-row sidebar-tasks-row${active ? " is-active" : ""}`}
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      title={t("sidebar.tasks")}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 12h4l3-8 4 16 3-8h4" />
      </svg>
      <span className="sidebar-scheduled-label">{t("sidebar.tasks")}</span>
      {runningCount > 0 && (
        <span className="sidebar-scheduled-badge" aria-label={t("sidebar.tasksRunning", { count: runningCount })}>
          {runningCount > 99 ? "99+" : runningCount}
        </span>
      )}
    </button>
  );
}
