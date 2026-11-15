import type { CalendarData, CalendarRun, SessionPrompt } from "@/lib/calendar-types";
import type { AgentTaskSnapshot, SessionInfo } from "@/lib/types";

export type CalendarView = "month" | "week";
export type CalendarEntryKind = "session" | "run" | "planned";
export type CalendarEntryStatus = "running" | "waiting" | "failed" | "aborted" | "done" | "planned";

export interface CalendarEntry {
  id: string;
  kind: CalendarEntryKind;
  /** ms; for a session, its first prompt that day. */
  at: number;
  dayKey: string;
  title: string;
  projectKey: string;
  projectLabel: string;
  status: CalendarEntryStatus | null;
  sessionId?: string;
  /** The session's own name, when it has one (the title then is that name). */
  sessionName?: string;
  /** A session's prompts that day, oldest first. */
  prompts?: SessionPrompt[];
  taskId?: string;
  run?: CalendarRun;
}

export const TYPE_SESSION = "type:session";
export const TYPE_SCHEDULED = "type:scheduled";
export const CHAT_PROJECT_KEY = "chat";
export const MONTH_CELL_LIMIT = 4;

// ---------- dates (local time) ----------

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Monday on or before `date`; the calendar's weeks start on Monday. */
export function mondayOf(date: Date): Date {
  return addDays(startOfDay(date), -((date.getDay() + 6) % 7));
}

export function weekdayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export function dayKey(value: Date | number): string {
  const date = typeof value === "number" ? new Date(value) : value;
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** The days the grid shows: one Monday-first week, or the whole weeks spanning the anchor's month. */
export function visibleDays(view: CalendarView, anchor: Date): Date[] {
  if (view === "week") {
    const monday = mondayOf(anchor);
    return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const start = mondayOf(first);
  const end = addDays(mondayOf(last), 7);
  const days: Date[] = [];
  for (let day = start; day < end; day = addDays(day, 1)) days.push(day);
  return days;
}

/** [from, to) in ms covering `days`. */
export function rangeOf(days: Date[]): { from: number; to: number } {
  return { from: days[0].getTime(), to: addDays(days[days.length - 1], 1).getTime() };
}

export function stepAnchor(view: CalendarView, anchor: Date, direction: 1 | -1): Date {
  if (view === "week") return addDays(anchor, 7 * direction);
  return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
}

// ---------- entries ----------

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

function sessionProject(session: SessionInfo, chatLabel: string): { key: string; label: string } {
  if (session.workspaceKind === "chat") return { key: CHAT_PROJECT_KEY, label: chatLabel };
  const root = session.projectRoot || session.cwd;
  return { key: session.projectKey || root, label: basename(root) };
}

function runStatus(run: CalendarRun): CalendarEntryStatus {
  switch (run.status) {
    case "running": return "running";
    case "succeeded": return "done";
    case "failed": return "failed";
    case "aborted": return "aborted";
  }
}

export interface BuildEntriesInput {
  data: CalendarData;
  sessions: SessionInfo[];
  snapshots: AgentTaskSnapshot[];
  runningSessionIds: ReadonlySet<string>;
  chatLabel: string;
}

/**
 * One entry per session per local day it got a prompt, titled by the session's
 * name if it has one and otherwise by that day's first prompt; one per
 * scheduled run; one per planned slot. Sub-agent runs, transient rows and the
 * sessions scheduled runs produced (shown as their run instead) are left out.
 * Live state (running, waiting, last run failed) marks only a session's
 * latest day.
 */
export function buildCalendarEntries({ data, sessions, snapshots, runningSessionIds, chatLabel }: BuildEntriesInput): CalendarEntry[] {
  const entries: CalendarEntry[] = [];
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.sessionId, snapshot]));
  const runSessionIds = new Set(data.runs.flatMap((run) => (run.sessionId ? [run.sessionId] : [])));

  for (const [sessionId, prompts] of Object.entries(data.prompts)) {
    const session = byId.get(sessionId);
    if (!session || session.transient || runSessionIds.has(sessionId)) continue;
    const kind = session.relation?.kind;
    if (kind === "subagent" || kind === "scheduled") continue;
    const project = sessionProject(session, chatLabel);
    const name = session.name?.replace(/\s+/g, " ").trim() || undefined;
    const days = new Map<string, SessionPrompt[]>();
    for (const prompt of [...prompts].sort((a, b) => a.at - b.at)) {
      const key = dayKey(prompt.at);
      const list = days.get(key);
      if (list) list.push(prompt);
      else days.set(key, [prompt]);
    }
    const snapshot = snapshotsById.get(sessionId);
    let liveStatus: CalendarEntryStatus | null = null;
    if (snapshot && snapshot.waiting.length > 0) liveStatus = "waiting";
    else if (snapshot?.running || runningSessionIds.has(sessionId)) liveStatus = "running";
    else if (snapshot?.lastRun?.outcome.status === "failed") liveStatus = "failed";
    const sessionEntries: CalendarEntry[] = [];
    for (const [key, dayPrompts] of days) {
      sessionEntries.push({
        id: `s:${sessionId}:${key}`,
        kind: "session",
        at: dayPrompts[0].at,
        dayKey: key,
        title: name ?? dayPrompts[0].text,
        projectKey: project.key,
        projectLabel: project.label,
        status: null,
        sessionId,
        ...(name ? { sessionName: name } : {}),
        prompts: dayPrompts,
      });
    }
    if (liveStatus && sessionEntries.length > 0) {
      const latest = sessionEntries.reduce((a, b) => (b.at > a.at ? b : a));
      latest.status = liveStatus;
    }
    entries.push(...sessionEntries);
  }

  const tasks = new Map(data.tasks.map((task) => [task.id, task]));
  const projectByCwd = new Map<string, { key: string; label: string }>();
  for (const session of sessions) {
    if (session.workspaceKind !== "chat" && !projectByCwd.has(session.cwd)) projectByCwd.set(session.cwd, sessionProject(session, chatLabel));
  }
  const taskProject = (cwd: string) => projectByCwd.get(cwd) ?? { key: cwd, label: basename(cwd) };

  for (const run of data.runs) {
    const task = tasks.get(run.taskId);
    if (!task) continue;
    const project = taskProject(task.cwd);
    entries.push({
      id: `r:${run.runId}`,
      kind: "run",
      at: run.at,
      dayKey: dayKey(run.at),
      title: task.name,
      projectKey: project.key,
      projectLabel: project.label,
      status: runStatus(run),
      taskId: task.id,
      run,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    });
  }
  for (const slot of data.planned) {
    const task = tasks.get(slot.taskId);
    if (!task) continue;
    const project = taskProject(task.cwd);
    entries.push({
      id: `p:${task.id}:${slot.at}`,
      kind: "planned",
      at: slot.at,
      dayKey: dayKey(slot.at),
      title: task.name,
      projectKey: project.key,
      projectLabel: project.label,
      status: "planned",
      taskId: task.id,
    });
  }
  return entries.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

export function isEntryVisible(entry: CalendarEntry, hidden: ReadonlySet<string>): boolean {
  if (hidden.has(entry.projectKey)) return false;
  return !hidden.has(entry.kind === "session" ? TYPE_SESSION : TYPE_SCHEDULED);
}

/** Entries grouped by local day, each day in time order (the input is already sorted). */
export function groupByDay(entries: CalendarEntry[]): Map<string, CalendarEntry[]> {
  const days = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const list = days.get(entry.dayKey);
    if (list) list.push(entry);
    else days.set(entry.dayKey, [entry]);
  }
  return days;
}

/** A month cell shows every entry up to the limit; past it, one row fewer plus "N more". */
export function monthCellItems<T>(items: T[], limit = MONTH_CELL_LIMIT): { shown: T[]; more: number } {
  if (items.length <= limit) return { shown: items, more: 0 };
  return { shown: items.slice(0, limit - 1), more: items.length - (limit - 1) };
}

/** The projects present in `entries`, for the filter menu: projects by name, chats last. */
export function calendarProjects(entries: CalendarEntry[]): Array<{ key: string; label: string }> {
  const seen = new Map<string, string>();
  for (const entry of entries) if (!seen.has(entry.projectKey)) seen.set(entry.projectKey, entry.projectLabel);
  return [...seen].map(([key, label]) => ({ key, label }))
    .sort((a, b) => Number(a.key === CHAT_PROJECT_KEY) - Number(b.key === CHAT_PROJECT_KEY) || a.label.localeCompare(b.label));
}
