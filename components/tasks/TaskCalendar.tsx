"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useScheduledTasks } from "@/hooks/useScheduledTasks";
import { getPref, getPrefJson, setPref, setPrefJson, APP_PREF_KEYS } from "@/lib/app-prefs";
import type { CalendarData, CalendarTask } from "@/lib/calendar-types";
import { showNativeMenu, type NativeMenuEntry } from "@/lib/desktop-menu";
import { openDomMenu } from "@/lib/dom-menu-store";
import { apiErrorText, scheduledApi } from "@/lib/scheduled-tasks/client";
import { describeRunError } from "@/lib/scheduled-tasks/run-error";
import type { AgentTaskSnapshot, SessionInfo } from "@/lib/types";
import { describeSchedule, formatDuration } from "../scheduled/scheduled-helpers";
import {
  buildCalendarEntries,
  calendarProjects,
  dayKey,
  groupByDay,
  isEntryVisible,
  monthCellItems,
  rangeOf,
  startOfDay,
  stepAnchor,
  visibleDays,
  weekdayIndex,
  TYPE_SCHEDULED,
  TYPE_SESSION,
  type CalendarEntry,
  type CalendarView,
} from "./calendar-helpers";

interface Props {
  sessions: SessionInfo[];
  snapshots: AgentTaskSnapshot[];
  runningSessionIds: ReadonlySet<string>;
  /** The Tasks / Calendar switch, drawn at the start of the toolbar. */
  modeSwitch: ReactNode;
  onOpenSession: (sessionId: string, entryId?: string) => void;
  onOpenScheduledTask: (taskId: string) => void;
}

/** Refresh while visible: "now" moves planned slots into the past and new prompts arrive. */
const REFRESH_MS = 60_000;

function useCalendarData(range: { from: number; to: number }, refreshKey: string) {
  const [data, setData] = useState<CalendarData | null>(null);
  const [failed, setFailed] = useState(false);
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const id = ++requestRef.current;
    try {
      const response = await fetch(`/api/calendar?from=${range.from}&to=${range.to}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json() as CalendarData;
      if (id !== requestRef.current) return;
      setData(next);
      setFailed(false);
    } catch {
      if (id === requestRef.current) setFailed(true);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    // Debounced: the session catalogue and running set change in bursts.
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load, refreshKey]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const current = data && data.from === range.from && data.to === range.to ? data : null;
  return { data: current, stale: data, failed };
}

function initialView(): CalendarView {
  return getPref(APP_PREF_KEYS.tasksCalendarView) === "week" ? "week" : "month";
}

function initialHidden(): Set<string> {
  const stored = getPrefJson<unknown>(APP_PREF_KEYS.tasksCalendarHidden);
  return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
}

function RepeatIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
  );
}

function EntryMark({ entry }: { entry: CalendarEntry }) {
  if (entry.kind === "session") {
    return <span className="task-cal-mark"><i className={`task-cal-dot task-cal-dot--${entry.status ?? "idle"}`} /></span>;
  }
  return (
    <span className={`task-cal-mark task-cal-mark--${entry.status ?? "planned"}`}>
      {entry.kind === "planned" ? <ClockIcon /> : <RepeatIcon />}
    </span>
  );
}

/**
 * The Tasks page calendar: every session on each day it got a prompt, and
 * scheduled tasks (runs that happened and runs still planned), by month or
 * by week. A click opens a preview beside the grid; right-click opens the
 * entry's menu. Phones get a day-by-day agenda instead of the grid.
 */
export function TaskCalendar({ sessions, snapshots, runningSessionIds, modeSwitch, onOpenSession, onOpenScheduledTask }: Props) {
  const { t, locale } = useI18n();
  const isMobile = useIsMobile();
  const { tasks: scheduledTasks } = useScheduledTasks();
  const [view, setViewState] = useState<CalendarView>(initialView);
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [hidden, setHidden] = useState<Set<string>>(initialHidden);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [today, setToday] = useState(() => startOfDay(new Date()));

  useEffect(() => {
    // Midnight moves "today"; checked on the same cadence as the data.
    const timer = setInterval(() => {
      const next = startOfDay(new Date());
      setToday((current) => (current.getTime() === next.getTime() ? current : next));
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const days = useMemo(() => visibleDays(view, anchor), [view, anchor]);
  const range = useMemo(() => rangeOf(days), [days]);
  const runningKey = [...runningSessionIds].sort().join(",");
  const tasksKey = scheduledTasks.map((task) => `${task.id}:${task.updatedAt}:${task.lastRun?.runId ?? ""}:${task.lastRun?.status ?? ""}`).join(",");
  const sessionsKey = `${sessions.length}:${sessions.reduce((latest, session) => (session.modified > latest ? session.modified : latest), "")}`;
  const { data, stale, failed } = useCalendarData(range, `${runningKey}|${tasksKey}|${sessionsKey}`);
  const shown = data ?? stale;

  const chatLabel = t("sidebar.chats");
  const allEntries = useMemo(
    () => (shown ? buildCalendarEntries({ data: shown, sessions, snapshots, runningSessionIds, chatLabel }) : []),
    [shown, sessions, snapshots, runningSessionIds, chatLabel],
  );
  const entries = useMemo(() => allEntries.filter((entry) => isEntryVisible(entry, hidden)), [allEntries, hidden]);
  const byDay = useMemo(() => groupByDay(entries), [entries]);
  const projects = useMemo(() => calendarProjects(allEntries), [allEntries]);
  const selected = selectedId ? allEntries.find((entry) => entry.id === selectedId) ?? null : null;
  const tasksById = useMemo(() => new Map((shown?.tasks ?? []).map((task) => [task.id, task])), [shown]);

  const setView = (next: CalendarView) => {
    setViewState(next);
    setPref(APP_PREF_KEYS.tasksCalendarView, next);
  };
  const updateHidden = (next: Set<string>) => {
    setHidden(next);
    setPrefJson(APP_PREF_KEYS.tasksCalendarHidden, [...next]);
  };

  // ---------- formatting ----------
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }), [locale]);
  const dayFormat = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", weekday: "short" }), [locale]);
  const weekdayFormat = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "short" }), [locale]);
  // 2026-11-16 is a Monday.
  const weekdayNames = useMemo(() => Array.from({ length: 7 }, (_, index) => weekdayFormat.format(new Date(2026, 10, 16 + index))), [weekdayFormat]);
  const time = (ms: number) => timeFormat.format(new Date(ms));
  const statusLabel = (entry: CalendarEntry) => (entry.status ? t(`tasks.calendar.status.${entry.status}`) : "");
  const hoverText = (entry: CalendarEntry) => [entry.title, time(entry.at), statusLabel(entry)].filter(Boolean).join(" · ");

  const rangeTitle = useMemo(() => {
    if (view === "month") return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(anchor);
    const format = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" });
    const first = days[0];
    const last = days[days.length - 1];
    const ranged = format as Intl.DateTimeFormat & { formatRange?: (a: Date, b: Date) => string };
    return ranged.formatRange ? ranged.formatRange(first, last) : `${format.format(first)} – ${format.format(last)}`;
  }, [view, locale, anchor, days]);

  // ---------- actions ----------
  const openRun = useCallback((entry: CalendarEntry) => {
    if (!entry.run?.sessionId || !entry.taskId) return;
    onOpenSession(entry.run.sessionId);
    void scheduledApi.markSeen(entry.taskId, entry.run.runId).catch(() => undefined);
  }, [onOpenSession]);

  const runNow = useCallback(async (taskId: string) => {
    setActionError(null);
    try {
      await scheduledApi.run(taskId);
    } catch (error) {
      setActionError(apiErrorText(error, t));
    }
  }, [t]);

  const copyTitle = (entry: CalendarEntry) => {
    void navigator.clipboard?.writeText(entry.title).catch(() => undefined);
  };

  const menuEntries = (entry: CalendarEntry): NativeMenuEntry[] => {
    const preview = { label: t("tasks.calendar.menu.preview"), onSelect: () => setSelectedId(entry.id) };
    if (entry.kind === "session" && entry.sessionId) {
      const sessionId = entry.sessionId;
      return [
        preview,
        { label: t("tasks.calendar.openSession"), onSelect: () => onOpenSession(sessionId) },
        { label: t("tasks.calendar.locateDay"), onSelect: () => onOpenSession(sessionId, entry.prompts?.[0]?.entryId) },
        { kind: "separator" },
        { label: t("tasks.calendar.menu.copyTitle"), onSelect: () => copyTitle(entry) },
      ];
    }
    const taskId = entry.taskId ?? "";
    if (entry.kind === "run") {
      return [
        preview,
        { label: t("tasks.calendar.openRun"), onSelect: () => openRun(entry), disabled: !entry.run?.sessionId },
        { label: t("tasks.calendar.viewTask"), onSelect: () => onOpenScheduledTask(taskId) },
        { kind: "separator" },
        { label: t("tasks.calendar.menu.copyTitle"), onSelect: () => copyTitle(entry) },
      ];
    }
    return [
      preview,
      { label: t("tasks.calendar.viewTask"), onSelect: () => onOpenScheduledTask(taskId) },
      { label: t("tasks.calendar.runNow"), onSelect: () => void runNow(taskId) },
    ];
  };

  const openMenu = (entries: NativeMenuEntry[], at: { x: number; y: number }) => {
    void showNativeMenu(entries, at).then((shown) => {
      if (!shown) openDomMenu(entries, at);
    });
  };

  const filterMenu = (anchorEl: HTMLElement) => {
    const toggle = (key: string) => {
      const next = new Set(hidden);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      updateHidden(next);
    };
    const entriesList: NativeMenuEntry[] = [
      { label: t("tasks.calendar.filter.sessions"), checked: !hidden.has(TYPE_SESSION), onSelect: () => toggle(TYPE_SESSION) },
      { label: t("tasks.calendar.filter.scheduled"), checked: !hidden.has(TYPE_SCHEDULED), onSelect: () => toggle(TYPE_SCHEDULED) },
      ...(projects.length > 0 ? [{ kind: "separator" } as const] : []),
      ...projects.map((project) => ({ label: project.label, checked: !hidden.has(project.key), onSelect: () => toggle(project.key) })),
      ...(hidden.size > 0 ? [{ kind: "separator" } as const, { label: t("tasks.calendar.filter.showAll"), onSelect: () => updateHidden(new Set()) }] : []),
    ];
    const rect = anchorEl.getBoundingClientRect();
    openMenu(entriesList, { x: rect.left, y: rect.bottom + 4 });
  };

  const dayMenu = (key: string, anchorEl: HTMLElement) => {
    const items = byDay.get(key) ?? [];
    const rect = anchorEl.getBoundingClientRect();
    openMenu(items.map((entry) => ({ label: hoverText(entry), onSelect: () => setSelectedId(entry.id) })), { x: rect.left, y: rect.bottom + 2 });
  };

  const goToWeek = (day: Date) => {
    setAnchor(day);
    setView("week");
  };

  // ---------- rendering ----------
  const renderItem = (entry: CalendarEntry, compact: boolean) => (
    <button
      key={entry.id}
      type="button"
      className={`task-cal-item task-cal-item--${entry.kind}${compact ? " is-compact" : ""}`}
      aria-pressed={entry.id === selectedId}
      title={hoverText(entry)}
      onClick={() => setSelectedId(entry.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu(menuEntries(entry), { x: event.clientX, y: event.clientY });
      }}
    >
      <EntryMark entry={entry} />
      <span className="task-cal-item-title">{entry.title}</span>
      {!compact && (
        <span className="task-cal-item-meta">
          <span>{time(entry.at)}</span>
          {entry.status && <span className={`task-cal-status--${entry.status}`}>{statusLabel(entry)}</span>}
          {!entry.status && entry.prompts && entry.prompts.length > 1 && (
            <span>{t("tasks.calendar.promptCount", { count: entry.prompts.length })}</span>
          )}
          <span>{entry.projectLabel}</span>
        </span>
      )}
    </button>
  );

  const isToday = (day: Date) => day.getTime() === today.getTime();

  const monthGrid = (
    <div className="task-cal-month-wrap">
      <div className="task-cal-weekdays" aria-hidden="true">
        {weekdayNames.map((name) => <div key={name}>{name}</div>)}
      </div>
      <div className="task-cal-month" style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(112px, 1fr))` }}>
        {days.map((day) => {
          const key = dayKey(day);
          const { shown: items, more } = monthCellItems(byDay.get(key) ?? []);
          const outside = day.getMonth() !== anchor.getMonth();
          return (
            <div key={key} className={`task-cal-cell${outside ? " is-outside" : ""}${isToday(day) ? " is-today" : ""}`}>
              <button
                type="button"
                className="task-cal-daynum"
                aria-label={t("tasks.calendar.openWeek", { day: dayFormat.format(day) })}
                onClick={() => goToWeek(day)}
              >
                {day.getDate()}
              </button>
              {items.map((entry) => renderItem(entry, true))}
              {more > 0 && (
                <button type="button" className="task-cal-more" onClick={(event) => dayMenu(key, event.currentTarget)}>
                  {t("tasks.calendar.more", { count: more })}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  const weekGrid = (
    <div className="task-cal-week">
      {days.map((day) => {
        const key = dayKey(day);
        const items = byDay.get(key) ?? [];
        return (
          <div key={key} className="task-cal-week-col">
            <div className={`task-cal-week-head${isToday(day) ? " is-today" : ""}`}>
              <span>{weekdayNames[weekdayIndex(day)]}</span>
              <span className="task-cal-week-num">{day.getDate()}</span>
            </div>
            <div className="task-cal-week-list">
              {items.length > 0 ? items.map((entry) => renderItem(entry, false)) : <span className="task-cal-empty">{t("tasks.calendar.emptyDay")}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );

  const agendaDays = days.filter((day) => view === "week" || day.getMonth() === anchor.getMonth())
    .filter((day) => isToday(day) || (byDay.get(dayKey(day))?.length ?? 0) > 0);
  const agenda = (
    <div className="task-cal-agenda">
      {agendaDays.length === 0 && <p className="task-cal-empty">{t("tasks.calendar.emptyRange")}</p>}
      {agendaDays.map((day) => {
        const items = byDay.get(dayKey(day)) ?? [];
        return (
          <div key={dayKey(day)} className={`task-cal-agenda-day${isToday(day) ? " is-today" : ""}`}>
            <div className="task-cal-agenda-date">
              <span>{weekdayNames[weekdayIndex(day)]}</span>
              <span className="task-cal-week-num">{day.getDate()}</span>
            </div>
            <div className="task-cal-agenda-list">
              {items.length > 0 ? items.map((entry) => renderItem(entry, false)) : <span className="task-cal-empty">{t("tasks.calendar.emptyToday")}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <div
      className="task-cal"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !selected) return;
        // Handled here, or the global shortcut would stop a running agent.
        event.preventDefault();
        setSelectedId(null);
      }}
    >
      <div className="task-cal-bar">
        {modeSwitch}
        <h2 className="task-cal-range" aria-live="polite">{rangeTitle}</h2>
        <div className="task-cal-bar-end">
          <div className="task-seg is-small" role="group" aria-label={t("tasks.calendar.rangeLabel")}>
            <button type="button" aria-pressed={view === "week"} onClick={() => setView("week")}>{t("tasks.calendar.week")}</button>
            <button type="button" aria-pressed={view === "month"} onClick={() => setView("month")}>{t("tasks.calendar.month")}</button>
          </div>
          <button
            type="button"
            className="task-cal-icon-btn"
            aria-label={t("tasks.calendar.filter")}
            title={t("tasks.calendar.filter")}
            onClick={(event) => filterMenu(event.currentTarget)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg>
            {hidden.size > 0 && <span className="task-cal-filter-badge" />}
          </button>
          <button type="button" className="task-cal-today" onClick={() => setAnchor(startOfDay(new Date()))}>{t("tasks.calendar.today")}</button>
          <button type="button" className="task-cal-icon-btn" aria-label={t("tasks.calendar.previous")} onClick={() => setAnchor((current) => stepAnchor(view, current, -1))}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
          </button>
          <button type="button" className="task-cal-icon-btn" aria-label={t("tasks.calendar.next")} onClick={() => setAnchor((current) => stepAnchor(view, current, 1))}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
          </button>
        </div>
      </div>
      {failed && <p className="scheduled-error task-cal-notice" role="alert">{t("tasks.calendar.loadFailed")}</p>}
      {actionError && <p className="scheduled-error task-cal-notice" role="alert">{actionError}</p>}
      <div className="task-cal-body">
        <div className="task-cal-main" aria-busy={!data}>
          {isMobile ? agenda : view === "month" ? monthGrid : weekGrid}
        </div>
        {selected && (
          <CalendarPreview
            entry={selected}
            task={selected.taskId ? tasksById.get(selected.taskId) : undefined}
            runReply={selected.run?.sessionId ? shown?.prompts[selected.run.sessionId]?.at(-1)?.reply : undefined}
            otherDays={selected.sessionId && selected.kind === "session" ? allEntries.filter((entry) => entry.kind === "session" && entry.sessionId === selected.sessionId) : []}
            dayLabel={dayFormat.format(new Date(selected.at))}
            time={time}
            dayFormat={(ms) => dayFormat.format(new Date(ms))}
            statusLabel={statusLabel(selected)}
            onSelect={(id) => {
              setSelectedId(id);
              const target = allEntries.find((entry) => entry.id === id);
              if (target && !days.some((day) => dayKey(day) === target.dayKey)) setAnchor(startOfDay(new Date(target.at)));
            }}
            onClose={() => setSelectedId(null)}
            onOpenSession={onOpenSession}
            onOpenRun={() => openRun(selected)}
            onOpenTask={onOpenScheduledTask}
            onRunNow={(taskId) => void runNow(taskId)}
          />
        )}
      </div>
    </div>
  );
}

interface PreviewProps {
  entry: CalendarEntry;
  task?: CalendarTask;
  runReply?: string;
  otherDays: CalendarEntry[];
  dayLabel: string;
  time: (ms: number) => string;
  dayFormat: (ms: number) => string;
  statusLabel: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  onOpenSession: (sessionId: string, entryId?: string) => void;
  onOpenRun: () => void;
  onOpenTask: (taskId: string) => void;
  onRunNow: (taskId: string) => void;
}

function CalendarPreview({
  entry, task, runReply, otherDays, dayLabel, time, dayFormat, statusLabel,
  onSelect, onClose, onOpenSession, onOpenRun, onOpenTask, onRunNow,
}: PreviewProps) {
  const { t, locale } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }); }, [entry.id]);

  const statusChip = entry.status ? <span className={`task-cal-chip task-cal-status--${entry.status}`}>{statusLabel}</span> : null;
  let eyebrow: string;
  let body: ReactNode;
  let actions: ReactNode;

  if (entry.kind === "session" && entry.sessionId) {
    const sessionId = entry.sessionId;
    const prompts = entry.prompts ?? [];
    const reply = [...prompts].reverse().find((prompt) => prompt.reply)?.reply;
    eyebrow = t("tasks.calendar.kind.session");
    body = (
      <>
        <div className="task-cal-chips">
          <span className="task-cal-chip">{dayLabel}</span>
          <span className="task-cal-chip">{t("tasks.calendar.promptCount", { count: prompts.length })}</span>
          {statusChip}
          {entry.sessionName && <span className="task-cal-chip">{t("tasks.calendar.named")}</span>}
        </div>
        <section className="task-cal-section">
          <h4>{t("tasks.calendar.dayPrompts")}</h4>
          <ol className="task-cal-prompts">
            {prompts.map((prompt) => (
              <li key={prompt.entryId}>
                <time>{time(prompt.at)}</time>
                <span>{prompt.text}</span>
              </li>
            ))}
          </ol>
        </section>
        {reply && (
          <section className="task-cal-section">
            <h4>{t("tasks.calendar.lastReply")}</h4>
            <p className={`task-cal-reply${entry.status === "failed" ? " is-error" : ""}`}>{reply}</p>
          </section>
        )}
        {otherDays.length > 1 && (
          <section className="task-cal-section">
            <h4>{t("tasks.calendar.otherDays")}</h4>
            <div className="task-cal-days">
              {[...otherDays].sort((a, b) => b.at - a.at).map((day) => (
                <button key={day.id} type="button" aria-current={day.id === entry.id} onClick={() => onSelect(day.id)}>
                  {dayFormat(day.at)}
                </button>
              ))}
            </div>
          </section>
        )}
      </>
    );
    actions = (
      <>
        <button type="button" className="task-cal-btn is-primary" onClick={() => onOpenSession(sessionId)}>{t("tasks.calendar.openSession")}</button>
        <button type="button" className="task-cal-btn" onClick={() => onOpenSession(sessionId, prompts[0]?.entryId)}>{t("tasks.calendar.locateDay")}</button>
      </>
    );
  } else {
    const taskId = entry.taskId ?? "";
    const run = entry.run;
    eyebrow = entry.kind === "planned" ? t("tasks.calendar.kind.planned") : t("tasks.calendar.kind.run");
    const failure = run && (run.status === "failed" || run.status === "aborted") ? describeRunError(run, t) : "";
    body = (
      <>
        <div className="task-cal-chips">
          <span className="task-cal-chip">{dayLabel} {time(entry.at)}</span>
          {statusChip}
        </div>
        <dl className="task-cal-facts">
          {task && (<><dt>{t("tasks.calendar.schedule")}</dt><dd>{describeSchedule(task.schedule, t, locale)}</dd></>)}
          <dt>{t("tasks.calendar.project")}</dt><dd>{entry.projectLabel}</dd>
          {run?.endedAt !== undefined && (<><dt>{t("tasks.calendar.duration")}</dt><dd>{formatDuration(run.endedAt - run.at)}</dd></>)}
        </dl>
        {task && (
          <section className="task-cal-section">
            <h4>{t("tasks.calendar.taskPrompt")}</h4>
            <p className="task-cal-reply">{task.prompt.length > 400 ? `${task.prompt.slice(0, 400)}…` : task.prompt}</p>
          </section>
        )}
        {failure && (
          <section className="task-cal-section">
            <h4>{t("tasks.calendar.failure")}</h4>
            <p className="task-cal-reply is-error">{failure}</p>
          </section>
        )}
        {!failure && runReply && (
          <section className="task-cal-section">
            <h4>{t("tasks.calendar.result")}</h4>
            <p className="task-cal-reply">{runReply}</p>
          </section>
        )}
        {entry.kind === "planned" && <p className="scheduled-hint">{t("tasks.calendar.plannedHint")}</p>}
      </>
    );
    actions = entry.kind === "run" ? (
      <>
        {run?.sessionId && <button type="button" className="task-cal-btn is-primary" onClick={onOpenRun}>{t("tasks.calendar.openRun")}</button>}
        <button type="button" className={`task-cal-btn${run?.sessionId ? "" : " is-primary"}`} onClick={() => onOpenTask(taskId)}>{t("tasks.calendar.viewTask")}</button>
      </>
    ) : (
      <>
        <button type="button" className="task-cal-btn is-primary" onClick={() => onOpenTask(taskId)}>{t("tasks.calendar.viewTask")}</button>
        <button type="button" className="task-cal-btn" onClick={() => onRunNow(taskId)}>{t("tasks.calendar.runNow")}</button>
      </>
    );
  }

  return (
    <aside className="task-cal-preview" aria-label={t("tasks.calendar.preview")}>
      <div className="task-cal-preview-head">
        <div className="task-cal-preview-heading">
          <div className="task-cal-eyebrow">{eyebrow} · {entry.projectLabel}</div>
          <h3>{entry.title}</h3>
        </div>
        <button ref={closeRef} type="button" className="task-cal-icon-btn" aria-label={t("tasks.calendar.closePreview")} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <div className="task-cal-preview-body">{body}</div>
      <div className="task-cal-preview-foot">{actions}</div>
    </aside>
  );
}
