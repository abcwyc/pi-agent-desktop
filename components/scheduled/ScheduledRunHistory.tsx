"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { scheduledApi } from "@/lib/scheduled-tasks/client";
import type { ScheduledRun, ScheduledTaskView } from "@/lib/scheduled-tasks/types";
import { formatDateTime, formatDuration, isUnread, runDuration, runTime } from "./scheduled-helpers";

interface Props {
  task: ScheduledTaskView;
  onOpenSession: (sessionId: string, run: ScheduledRun) => void;
}

const PAGE = 20;

/** Past runs of one task, newest first. Reloads whenever the task's latest run changes. */
export function ScheduledRunHistory({ task, onOpenSession }: Props) {
  const { t, locale } = useI18n();
  const [runs, setRuns] = useState<ScheduledRun[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const latest = task.lastRun;
  const refreshKey = `${task.id}|${latest?.runId ?? ""}|${latest?.status ?? ""}|${latest?.seenAt ?? ""}|${task.unreadRuns}`;

  useEffect(() => {
    const id = ++requestId.current;
    scheduledApi.runs(task.id, { limit: PAGE })
      .then((page) => {
        if (id !== requestId.current) return;
        setRuns(page.runs);
        setHasMore(page.hasMore);
        setError(null);
      })
      .catch((caught) => {
        if (id === requestId.current) setError(caught instanceof Error ? caught.message : String(caught));
      });
  // The key already encodes everything that should trigger a reload.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const loadMore = useCallback(async () => {
    const last = runs?.[runs.length - 1];
    if (!last) return;
    try {
      const page = await scheduledApi.runs(task.id, { before: last.runId, limit: PAGE });
      setRuns((current) => [...(current ?? []), ...page.runs]);
      setHasMore(page.hasMore);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [runs, task.id]);

  return (
    <section className="scheduled-section" aria-labelledby={`history-${task.id}`}>
      <h3 id={`history-${task.id}`} className="scheduled-section-title">{t("scheduled.history.title")}</h3>
      {error && <p className="scheduled-error" role="alert">{error}</p>}
      {runs && runs.length === 0 && <p className="scheduled-hint">{t("scheduled.history.empty")}</p>}
      <ul className="scheduled-runs">
        {runs?.map((run) => {
          const time = runTime(run);
          const duration = runDuration(run);
          const unread = isUnread(run);
          return (
            <li key={run.runId} className={`scheduled-run scheduled-run--${run.status}`}>
              <span className="scheduled-run-dot" aria-hidden="true" />
              <div className="scheduled-run-main">
                <div className="scheduled-run-line">
                  <strong>{t(`scheduled.run.status.${run.status}`)}</strong>
                  <span className="scheduled-tag">{t(`scheduled.run.trigger.${run.trigger}`)}</span>
                  {time && <span className="scheduled-hint">{formatDateTime(time, locale)}</span>}
                  {duration !== null && <span className="scheduled-hint">{formatDuration(duration)}</span>}
                  {unread && <span className="scheduled-unread">{t("scheduled.run.unread")}</span>}
                </div>
                {run.skipReason && <p className="scheduled-hint">{t(`scheduled.run.skip.${run.skipReason}`)}</p>}
                {run.skippedSlots ? <p className="scheduled-hint">{t("scheduled.run.skippedSlots", { count: run.skippedSlots })}</p> : null}
                {run.error && <p className="scheduled-run-error">{run.error}</p>}
              </div>
              {run.sessionId && (
                <button type="button" className="scheduled-button scheduled-button--small" onClick={() => onOpenSession(run.sessionId as string, run)}>
                  {t("scheduled.history.open")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {hasMore && <button type="button" className="scheduled-button" onClick={() => void loadMore()}>{t("scheduled.history.more")}</button>}
    </section>
  );
}
