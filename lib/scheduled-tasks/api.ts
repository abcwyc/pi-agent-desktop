import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "../request-security";
import { nextCronRun } from "./cron";
import { listRuns } from "./store";
import {
  isValidationError,
  type ScheduledTask,
  type ScheduledTaskView,
} from "./types";

export function toTaskView(task: ScheduledTask, now = new Date()): ScheduledTaskView {
  const runs = listRuns(task.id);
  let nextRunAt: string | null = null;
  if (task.enabled) {
    if (task.schedule.kind === "cron") {
      try {
        nextRunAt = nextCronRun(task.schedule.expr, task.schedule.timezone, now)?.toISOString() ?? null;
      } catch {
        nextRunAt = null;
      }
    } else if (task.schedule.kind === "once") {
      nextRunAt = task.schedule.at;
    }
  }
  const finished = runs.filter((run) => run.status !== "running" && run.status !== "skipped");
  return {
    ...task,
    nextRunAt,
    lastRun: runs.length ? runs[runs.length - 1] : null,
    unreadRuns: finished.filter((run) => run.sessionId && !run.seenAt).length,
  };
}

/** Shared guard for routes that change anything. Returns a response to send, or null to go on. */
export function rejectUnsafeWrite(req: Request, options: { json?: boolean } = {}): NextResponse | null {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (options.json !== false && !hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  return null;
}

export function errorResponse(error: unknown): NextResponse {
  if (isValidationError(error)) {
    return NextResponse.json({
      error: error.message,
      code: "validation",
      ...(error.key ? { key: error.key, ...(error.params ? { params: error.params } : {}) } : {}),
    }, { status: 400 });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}
