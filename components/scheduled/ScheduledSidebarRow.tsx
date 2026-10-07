"use client";

import { summarizeScheduledTasks, useScheduledTasks } from "@/hooks/useScheduledTasks";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  active: boolean;
  onOpen: () => void;
}

/** The Scheduled entry under New Session: opens the task list, badges unread runs. */
export function ScheduledSidebarRow({ active, onOpen }: Props) {
  const { t } = useI18n();
  const { tasks, runningTaskIds } = useScheduledTasks();
  const { unread, running, attention } = summarizeScheduledTasks(tasks, runningTaskIds);

  return (
    <button
      type="button"
      className={`sidebar-header-row sidebar-scheduled-row${active ? " is-active" : ""}`}
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      title={t("sidebar.scheduled")}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <polyline points="12 7 12 12 15.5 14" />
      </svg>
      <span className="sidebar-scheduled-label">{t("sidebar.scheduled")}</span>
      {unread > 0 ? (
        <span className="sidebar-scheduled-badge" aria-label={t("sidebar.scheduledUnread", { count: unread })}>
          {unread > 99 ? "99+" : unread}
        </span>
      ) : running ? (
        <span className="sidebar-scheduled-dot sidebar-scheduled-dot--running" aria-hidden="true" />
      ) : attention ? (
        <span className="sidebar-scheduled-dot sidebar-scheduled-dot--attention" aria-hidden="true" />
      ) : null}
    </button>
  );
}
