import { Cron } from "croner";
import { MIN_INTERVAL_MINUTES, ScheduledTaskValidationError } from "./types";

/** How many upcoming runs are compared to find the shortest gap. */
const INTERVAL_SAMPLE = 100;

export function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function build(expr: string, timezone: string): Cron {
  // Six and seven field patterns add seconds and years; the UI offers neither.
  if (expr.trim().split(/\s+/).length !== 5) {
    throw new ScheduledTaskValidationError("cron expression must have exactly five fields");
  }
  try {
    const cron = new Cron(expr.trim(), { timezone, paused: true });
    // croner validates the timezone lazily, on the first date it computes.
    cron.nextRun(new Date());
    return cron;
  } catch (error) {
    if (error instanceof ScheduledTaskValidationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ScheduledTaskValidationError(
      /timezone/i.test(message) ? `invalid timezone: ${timezone}` : `invalid cron expression: ${expr}`,
    );
  }
}

/** Throws ScheduledTaskValidationError for an unusable expression, timezone or cadence. */
export function validateCron(expr: string, timezone: string, from: Date = new Date()): void {
  const cron = build(expr, timezone);
  const runs = cron.nextRuns(INTERVAL_SAMPLE, from);
  for (let index = 1; index < runs.length; index += 1) {
    const gapMinutes = (runs[index].getTime() - runs[index - 1].getTime()) / 60_000;
    if (gapMinutes < MIN_INTERVAL_MINUTES) {
      throw new ScheduledTaskValidationError(
        `runs must be at least ${MIN_INTERVAL_MINUTES} minutes apart`,
      );
    }
  }
}

export function nextCronRuns(expr: string, timezone: string, count: number, from: Date = new Date()): Date[] {
  return build(expr, timezone).nextRuns(count, from);
}

export function nextCronRun(expr: string, timezone: string, from: Date = new Date()): Date | null {
  return build(expr, timezone).nextRun(from);
}

/** Newest slot at or before `at`. */
export function previousCronRun(expr: string, timezone: string, at: Date): Date | null {
  // croner's previousRuns() works in whole seconds and leaves out the slot equal to
  // the reference's second. Looking one second ahead yields the newest slot at or
  // before trunc(at), and slots fall on whole seconds, so none after `at` can appear.
  return build(expr, timezone).previousRuns(1, new Date(at.getTime() + 1000))[0] ?? null;
}

/** Slots strictly after `since` and strictly before `until`, capped at `limit`. */
export function countCronSlotsBetween(
  expr: string,
  timezone: string,
  since: Date,
  until: Date,
  limit = 1000,
): number {
  const cron = build(expr, timezone);
  let count = 0;
  let cursor: Date | null = since;
  while (count < limit) {
    cursor = cron.nextRun(cursor);
    if (!cursor || cursor.getTime() >= until.getTime()) break;
    count += 1;
  }
  return count;
}
