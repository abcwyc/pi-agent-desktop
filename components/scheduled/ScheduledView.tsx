"use client";

import { useEffect, useRef, useState } from "react";
import { refreshScheduledTasks, useScheduledTasks } from "@/hooks/useScheduledTasks";
import { useI18n } from "@/hooks/useI18n";
import { formatRelativeTime } from "@/lib/i18n/format";
import { scheduledApi } from "@/lib/scheduled-tasks/client";
import type { ScheduledRun, ScheduledTaskView } from "@/lib/scheduled-tasks/types";
import { ScheduledRunHistory } from "./ScheduledRunHistory";
import { ScheduledTaskEditor } from "./ScheduledTaskEditor";
import { TOOL_PRESET_KEYS, canWrite, describeSchedule, formatDateTime, taskStatus } from "./scheduled-helpers";

interface Props {
  projectRoots: string[];
  /** Folder preselected for a new task. */
  defaultCwd: string | null;
  onBrowseFolder?: () => Promise<string | null>;
  /** Open a run's session in the chat view. */
  onOpenSession: (sessionId: string) => void;
}

type Mode = { kind: "list" } | { kind: "detail"; id: string } | { kind: "edit"; id: string | null };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The Scheduled page: task list, a task's detail with its run history, and the editor. */
export function ScheduledView({ projectRoots, defaultCwd, onBrowseFolder, onOpenSession }: Props) {
  const { t, locale } = useI18n();
  const { tasks, loaded, error, schedulerOwner, runningTaskIds } = useScheduledTasks();
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ScheduledTaskView | null>(null);
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);

  const selected = mode.kind === "list" ? null : tasks.find((task) => task.id === mode.id) ?? null;
  // A task that disappeared (deleted elsewhere) sends a detail view back to the list.
  const effectiveMode: Mode = mode.kind === "detail" && !selected ? { kind: "list" } : mode;

  async function act(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setActionError(null);
    try {
      await action();
      await refreshScheduledTasks();
    } catch (caught) {
      setActionError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  function openRun(sessionId: string, task: ScheduledTaskView, run: ScheduledRun) {
    onOpenSession(sessionId);
    if (!run.seenAt) void scheduledApi.markSeen(task.id, run.runId).catch(() => undefined);
  }

  const statusLabel = (task: ScheduledTaskView) => t(`scheduled.status.${taskStatus(task, runningTaskIds)}`);
  const lastRunText = (task: ScheduledTaskView) => {
    const time = task.lastRun?.startedAt ?? task.lastRun?.scheduledFor;
    return time ? formatRelativeTime(time, locale) : t("scheduled.never");
  };

  return (
    <section
      ref={rootRef}
      className="scheduled-view"
      tabIndex={-1}
      aria-label={t("scheduled.title")}
      // Esc here must not reach the global shortcut that stops the agent running behind this page.
      onKeyDown={(event) => { if (event.key === "Escape") event.preventDefault(); }}
    >
      <div className="scheduled-shell">
        {effectiveMode.kind === "list" && (
          <>
            <header className="scheduled-header">
              <div>
                <h2 className="scheduled-title">{t("scheduled.title")}</h2>
                <p className="scheduled-subtitle">{t("scheduled.subtitle")}</p>
              </div>
              <button type="button" className="scheduled-button scheduled-button--primary" onClick={() => setMode({ kind: "edit", id: null })}>
                {t("scheduled.new")}
              </button>
            </header>
            {schedulerOwner === false && <p className="scheduled-notice" role="status">{t("scheduled.ownerNotice")}</p>}
            {error && <p className="scheduled-error" role="alert">{t("scheduled.loadFailed", { error })}</p>}
            {!loaded && <p className="scheduled-hint">{t("scheduled.loading")}</p>}
            {loaded && !error && tasks.length === 0 && (
              <div className="scheduled-empty">
                <h3>{t("scheduled.empty.title")}</h3>
                <p>{t("scheduled.empty.body")}</p>
              </div>
            )}
            <ul className="scheduled-list">
              {tasks.map((task) => {
                const status = taskStatus(task, runningTaskIds);
                return (
                  <li key={task.id}>
                    <button type="button" className="scheduled-card" onClick={() => setMode({ kind: "detail", id: task.id })}>
                      <span className={`scheduled-status-dot scheduled-status-dot--${status}`} aria-hidden="true" />
                      <span className="scheduled-card-main">
                        <span className="scheduled-card-name">{task.name}</span>
                        <span className="scheduled-hint">{describeSchedule(task.schedule, t, locale)}</span>
                      </span>
                      <span className="scheduled-card-meta">
                        <span className={`scheduled-tag scheduled-tag--${status}`}>{statusLabel(task)}</span>
                        <span className="scheduled-hint">
                          {task.nextRunAt ? `${t("scheduled.nextRun")}: ${formatDateTime(task.nextRunAt, locale)}` : `${t("scheduled.lastRun")}: ${lastRunText(task)}`}
                        </span>
                      </span>
                      {task.unreadRuns > 0 && <span className="scheduled-unread-count" aria-label={t("sidebar.scheduledUnread", { count: task.unreadRuns })}>{task.unreadRuns}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {effectiveMode.kind === "edit" && (
          <>
            <button type="button" className="scheduled-back" onClick={() => setMode(selected ? { kind: "detail", id: selected.id } : { kind: "list" })}>← {selected ? selected.name : t("scheduled.back")}</button>
            <h2 className="scheduled-title">{selected ? t("scheduled.edit") : t("scheduled.new")}</h2>
            <ScheduledTaskEditor
              key={selected?.id ?? "new"}
              task={selected}
              projectRoots={projectRoots}
              defaultCwd={defaultCwd}
              onBrowseFolder={onBrowseFolder}
              onCancel={() => setMode(selected ? { kind: "detail", id: selected.id } : { kind: "list" })}
              onSaved={(saved) => {
                void refreshScheduledTasks();
                setMode({ kind: "detail", id: saved.id });
              }}
            />
          </>
        )}

        {effectiveMode.kind === "detail" && selected && (
          <>
            <button type="button" className="scheduled-back" onClick={() => setMode({ kind: "list" })}>← {t("scheduled.back")}</button>
            <header className="scheduled-header">
              <div>
                <h2 className="scheduled-title">{selected.name}</h2>
                {selected.description && <p className="scheduled-subtitle">{selected.description}</p>}
              </div>
              <div className="scheduled-actions">
                <button type="button" className="scheduled-button scheduled-button--primary" disabled={busy !== null || runningTaskIds.has(selected.id)} onClick={() => void act("run", () => scheduledApi.run(selected.id))}>
                  {busy === "run" ? t("scheduled.runStarting") : t("scheduled.runNow")}
                </button>
                {selected.schedule.kind !== "manual" && (
                  <button type="button" className="scheduled-button" disabled={busy !== null} onClick={() => void act("toggle", () => scheduledApi.update(selected.id, { enabled: !selected.enabled }))}>
                    {selected.enabled ? t("scheduled.pause") : t("scheduled.resume")}
                  </button>
                )}
                <button type="button" className="scheduled-button" onClick={() => setMode({ kind: "edit", id: selected.id })}>{t("scheduled.edit")}</button>
                <button type="button" className="scheduled-button scheduled-button--danger" onClick={() => setConfirmDelete(selected)}>{t("scheduled.delete")}</button>
              </div>
            </header>

            {actionError && <p className="scheduled-error" role="alert">{actionError}</p>}
            {selected.autoPausedReason && <p className="scheduled-warning" role="status">{t("scheduled.autoPaused", { reason: selected.autoPausedReason })}</p>}
            {schedulerOwner === false && <p className="scheduled-notice" role="status">{t("scheduled.ownerNotice")}</p>}

            <dl className="scheduled-facts">
              <div><dt>{t("scheduled.field.schedule")}</dt><dd>{describeSchedule(selected.schedule, t, locale)}</dd></div>
              <div><dt>{t("scheduled.nextRun")}</dt><dd>{selected.nextRunAt ? formatDateTime(selected.nextRunAt, locale) : "—"}</dd></div>
              <div><dt>{t("scheduled.lastRun")}</dt><dd>{lastRunText(selected)}</dd></div>
              <div><dt>{t("scheduled.field.folder")}</dt><dd className="scheduled-mono">{selected.cwd}</dd></div>
              <div>
                <dt>{t("scheduled.field.tools")}</dt>
                <dd><span className={`scheduled-tag${canWrite(selected.toolPreset) ? " scheduled-tag--write" : ""}`}>{t(TOOL_PRESET_KEYS[selected.toolPreset])}</span></dd>
              </div>
              <div><dt>{t("scheduled.field.model")}</dt><dd>{selected.model ? `${selected.model.provider}/${selected.model.modelId}` : t("scheduled.model.default")}{selected.thinkingLevel ? ` · ${selected.thinkingLevel}` : ""}</dd></div>
              <div><dt>{t("scheduled.field.timeLimit")}</dt><dd>{t("scheduled.timeLimit.minutes", { count: selected.maxDurationMin })}</dd></div>
            </dl>

            <section className="scheduled-section">
              <h3 className="scheduled-section-title">{t("scheduled.field.prompt")}</h3>
              <pre className="scheduled-prompt">{selected.prompt}</pre>
            </section>

            <ScheduledRunHistory task={selected} onOpenSession={(sessionId, run) => openRun(sessionId, selected, run)} />
          </>
        )}
      </div>

      {confirmDelete && (
        <DeleteDialog
          task={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={async (deleteHistory) => {
            const task = confirmDelete;
            setConfirmDelete(null);
            await act("delete", () => scheduledApi.remove(task.id, { deleteHistory }));
            setMode({ kind: "list" });
          }}
        />
      )}
    </section>
  );
}

function DeleteDialog({ task, onCancel, onConfirm }: {
  task: ScheduledTaskView;
  onCancel: () => void;
  onConfirm: (deleteHistory: boolean) => void;
}) {
  const { t } = useI18n();
  const [deleteHistory, setDeleteHistory] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div className="scheduled-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="scheduled-dialog" role="alertdialog" aria-modal="true" aria-labelledby="scheduled-delete-title">
        <h3 id="scheduled-delete-title">{t("scheduled.deleteTitle", { name: task.name })}</h3>
        <p>{t("scheduled.deleteBody")}</p>
        <label className="scheduled-check">
          <input type="checkbox" checked={deleteHistory} onChange={(event) => setDeleteHistory(event.target.checked)} />
          <span>{t("scheduled.deleteHistory")}</span>
        </label>
        <div className="scheduled-actions">
          <button type="button" className="scheduled-button" autoFocus onClick={onCancel}>{t("scheduled.cancel")}</button>
          <button type="button" className="scheduled-button scheduled-button--danger" onClick={() => onConfirm(deleteHistory)}>{t("scheduled.confirmDelete")}</button>
        </div>
      </div>
    </div>
  );
}
