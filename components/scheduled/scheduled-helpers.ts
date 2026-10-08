import { formatClock, presetFromCron } from "@/lib/scheduled-tasks/schedule-presets";
import type { ScheduledRun, ScheduledTaskView, TaskSchedule } from "@/lib/scheduled-tasks/types";

export type Translate = (key: string, params?: Record<string, string | number>) => string;

export type TaskStatus = "running" | "active" | "paused" | "attention" | "manual" | "done";

/** One word for how a task is doing, for the status dot and its label. */
export function taskStatus(task: ScheduledTaskView, running: ReadonlySet<string>): TaskStatus {
  if (running.has(task.id) || task.lastRun?.status === "running") return "running";
  if (task.autoPausedReason) return "attention";
  if (!task.enabled) return task.schedule.kind === "once" && task.lastRun ? "done" : "paused";
  if (task.schedule.kind === "manual") return "manual";
  return "active";
}

function weekdayName(weekday: number, locale: string): string {
  // 2026-10-04 is a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(new Date(2026, 9, 4 + weekday));
}

export function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** The schedule in words, matching what the editor would show for it. */
export function describeSchedule(schedule: TaskSchedule, t: Translate, locale: string): string {
  if (schedule.kind === "manual") return t("scheduled.describe.manual");
  if (schedule.kind === "once") return t("scheduled.describe.once", { time: formatDateTime(schedule.at, locale) });
  const spec = presetFromCron(schedule.expr);
  if (!spec) return t("scheduled.describe.custom", { expr: schedule.expr });
  const time = formatClock(spec.hour, spec.minute);
  switch (spec.preset) {
    case "hourly": return t("scheduled.describe.hourly", { minute: String(spec.minute).padStart(2, "0") });
    case "daily": return t("scheduled.describe.daily", { time });
    case "weekdays": return t("scheduled.describe.weekdays", { time });
    case "weekly": return t("scheduled.describe.weekly", { day: weekdayName(spec.weekday, locale), time });
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function runDuration(run: ScheduledRun): number | null {
  if (!run.startedAt || !run.endedAt) return null;
  const ms = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** The moment shown for a run: when it began, or the slot it covered if it never began. */
export function runTime(run: ScheduledRun): string | undefined {
  return run.startedAt ?? run.scheduledFor;
}

/** A run whose session the user can open, and has not yet. */
export function isUnread(run: ScheduledRun): boolean {
  return Boolean(run.sessionId) && run.status !== "running" && run.status !== "skipped" && !run.seenAt;
}

export const TOOL_PRESET_KEYS = {
  none: "scheduled.tools.none",
  "read-only": "scheduled.tools.readOnly",
  default: "scheduled.tools.default",
  full: "scheduled.tools.full",
} as const;

export function canWrite(preset: ScheduledTaskView["toolPreset"]): boolean {
  return preset === "default" || preset === "full";
}

/** `datetime-local` value for an ISO instant, in the viewer's own time zone. */
export function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInputValue(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
