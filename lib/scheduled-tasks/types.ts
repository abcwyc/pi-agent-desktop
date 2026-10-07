import type { ConcreteToolPreset } from "../tool-presets";

/** Shortest allowed gap between two runs of one cron task (LLM cost guard). */
export const MIN_INTERVAL_MINUTES = 5;
export const DEFAULT_MAX_DURATION_MINUTES = 30;
export const MAX_DURATION_MINUTES = 24 * 60;
/** A task that fails this many runs in a row is paused. */
export const MAX_CONSECUTIVE_FAILURES = 5;
/** Scheduled and catch-up runs started at once; manual runs are not capped. */
export const MAX_CONCURRENT_RUNS = 2;
/** A slot this recent still counts as on time rather than a catch-up. */
export const ON_TIME_GRACE_MS = 2 * 60_000;
/** Slots older than this are dropped instead of caught up. */
export const CATCH_UP_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const MAX_RUNS_PER_TASK = 200;
export const MAX_PROMPT_LENGTH = 100_000;
export const MAX_NAME_LENGTH = 120;

export type ScheduledThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type TaskSchedule =
  | { kind: "manual" }
  | { kind: "cron"; expr: string; timezone: string }
  | { kind: "once"; at: string };

export interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  /** Sent as the first user message of every run. */
  prompt: string;
  cwd: string;
  schedule: TaskSchedule;
  model?: { provider: string; modelId: string };
  thinkingLevel?: ScheduledThinkingLevel;
  toolPreset: ConcreteToolPreset;
  maxDurationMin: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Newest schedule slot already handled; the catch-up logic starts after it. */
  lastScheduledFor?: string;
  consecutiveFailures: number;
  /** Why the task was switched off without the user asking. */
  autoPausedReason?: string;
}

export type RunTrigger = "schedule" | "catch-up" | "manual";
export type RunStatus = "running" | "succeeded" | "failed" | "aborted" | "skipped";
export type RunSkipReason = "app-asleep" | "overlap";

export interface ScheduledRun {
  runId: string;
  taskId: string;
  trigger: RunTrigger;
  scheduledFor?: string;
  startedAt?: string;
  endedAt?: string;
  status: RunStatus;
  skipReason?: RunSkipReason;
  /** Earlier slots dropped because this run covers for them. */
  skippedSlots?: number;
  sessionId?: string;
  error?: string;
  /** Set once the user opens the run's session. */
  seenAt?: string;
  /** Process that owns a `running` record, to tell it from an orphaned one. */
  pid?: number;
}

export class ScheduledTaskValidationError extends Error {
  readonly code = "validation";
  constructor(message: string) {
    super(message);
    this.name = "ScheduledTaskValidationError";
  }
}

/**
 * Errors cross module graphs here: the scheduler is created by instrumentation
 * while route handlers are bundled separately, so each side has its own copy of
 * every class and `instanceof` is unreliable. Match on `name` instead.
 */
export function isNamedError(error: unknown, name: string): error is Error {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === name;
}

export function isValidationError(error: unknown): error is ScheduledTaskValidationError {
  return isNamedError(error, "ScheduledTaskValidationError");
}

export type ScheduledTaskEvent =
  | { type: "task_changed"; taskId: string }
  | { type: "run_started"; taskId: string; runId: string; sessionId?: string; trigger: RunTrigger }
  | { type: "run_finished"; taskId: string; runId: string; sessionId?: string; status: RunStatus; error?: string }
  | { type: "run_skipped"; taskId: string; runId: string; skipReason: RunSkipReason }
  | { type: "scheduler_owner"; owner: boolean };
