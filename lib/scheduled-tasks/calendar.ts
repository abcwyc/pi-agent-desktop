import type { CalendarPlannedRun, CalendarRun, CalendarTask } from "../calendar-types";
import { nextCronRun } from "./cron";
import type { ScheduledRun, ScheduledTask } from "./types";

/** Upper bound on planned slots per task, so a five-minute cron cannot flood a month. */
export const MAX_PLANNED_PER_TASK = 400;

function ms(iso: string | undefined): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
}

export function calendarTask(task: ScheduledTask): CalendarTask {
  return { id: task.id, name: task.name, prompt: task.prompt, cwd: task.cwd, schedule: task.schedule, enabled: task.enabled };
}

/** Runs that started (or were due) in [from, to). Skipped slots never ran and are left out. */
export function calendarRuns(runs: ScheduledRun[], from: number, to: number): CalendarRun[] {
  const out: CalendarRun[] = [];
  for (const run of runs) {
    if (run.status === "skipped") continue;
    const at = ms(run.startedAt) ?? ms(run.scheduledFor);
    if (at === null || at < from || at >= to) continue;
    const endedAt = ms(run.endedAt);
    out.push({
      runId: run.runId,
      taskId: run.taskId,
      at,
      status: run.status,
      ...(endedAt !== null ? { endedAt } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run.error ? { error: run.error } : {}),
      ...(run.errorCode ? { errorCode: run.errorCode } : {}),
      ...(run.errorParams ? { errorParams: run.errorParams } : {}),
    });
  }
  return out;
}

/** Slots an enabled task will run in [max(from, now), to). Past slots show as runs instead. */
export function plannedRuns(task: ScheduledTask, from: number, to: number, now: number): CalendarPlannedRun[] {
  if (!task.enabled) return [];
  const start = Math.max(from, now);
  if (start >= to) return [];
  if (task.schedule.kind === "once") {
    const at = ms(task.schedule.at);
    return at !== null && at >= start && at < to ? [{ taskId: task.id, at }] : [];
  }
  if (task.schedule.kind !== "cron") return [];
  const out: CalendarPlannedRun[] = [];
  // nextCronRun leaves out a slot equal to its reference, so start just before.
  let cursor = new Date(start - 1);
  try {
    while (out.length < MAX_PLANNED_PER_TASK) {
      const next = nextCronRun(task.schedule.expr, task.schedule.timezone, cursor);
      if (!next || next.getTime() >= to) break;
      out.push({ taskId: task.id, at: next.getTime() });
      cursor = next;
    }
  } catch {
    // An expression that no longer parses has no future slots to show.
  }
  return out;
}
