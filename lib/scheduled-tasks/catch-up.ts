import { countCronSlotsBetween, previousCronRun } from "./cron";
import {
  CATCH_UP_WINDOW_MS,
  ON_TIME_GRACE_MS,
  type RunTrigger,
  type ScheduledTask,
} from "./types";

export type SlotDecision =
  | { action: "none" }
  /** Start a run for `scheduledFor`; earlier slots counted in `skippedSlots` are dropped. */
  | { action: "fire"; trigger: Exclude<RunTrigger, "manual">; scheduledFor: Date; skippedSlots: number }
  /** Nothing is worth running, but the slot is too old to keep: record it and move on. */
  | { action: "drop"; scheduledFor: Date; skippedSlots: number };

/**
 * Decide what the scheduler owes a task at `now`.
 *
 * `since` is the newest slot already handled (`lastScheduledFor`, or the moment
 * the schedule last changed). At most one run starts per call: the most recent
 * slot, as an on-time run when it is fresh and as a catch-up run when the app
 * was asleep or closed for a while. Older slots are not replayed.
 */
export function decideSlot(task: ScheduledTask, now: Date, since: Date): SlotDecision {
  const schedule = task.schedule;
  if (schedule.kind === "manual") return { action: "none" };

  let due: Date | null;
  let skipped = 0;
  if (schedule.kind === "once") {
    due = new Date(schedule.at);
    if (Number.isNaN(due.getTime()) || due.getTime() > now.getTime()) return { action: "none" };
  } else {
    due = previousCronRun(schedule.expr, schedule.timezone, now);
    if (due) {
      skipped = countCronSlotsBetween(schedule.expr, schedule.timezone, since, due);
    }
  }
  if (!due || due.getTime() <= since.getTime()) return { action: "none" };

  const age = now.getTime() - due.getTime();
  if (age <= ON_TIME_GRACE_MS) {
    return { action: "fire", trigger: "schedule", scheduledFor: due, skippedSlots: skipped };
  }
  if (age <= CATCH_UP_WINDOW_MS) {
    return { action: "fire", trigger: "catch-up", scheduledFor: due, skippedSlots: skipped };
  }
  return { action: "drop", scheduledFor: due, skippedSlots: skipped + 1 };
}
