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
  /** Set when repeated failures switched the task off: the error of the run that did. */
  autoPausedReason?: string;
}

export type RunTrigger = "schedule" | "catch-up" | "manual";
export type RunStatus = "running" | "succeeded" | "failed" | "aborted" | "skipped";
export type RunSkipReason = "app-asleep" | "overlap";
/**
 * Why a run ended the way it did, for the errors this module produces itself.
 * The UI turns the code into the reader's language; `error` stays English as
 * the fallback (and for errors that come from the model provider, which have no code).
 */
export type RunErrorCode = "time-limit" | "interrupted" | "stopped" | "cwd-missing";
export type MessageParams = Record<string, string | number>;

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
  errorCode?: RunErrorCode;
  errorParams?: MessageParams;
  /** Set once the user opens the run's session. */
  seenAt?: string;
  /** Process that owns a `running` record, to tell it from an orphaned one. */
  pid?: number;
}

/** A task as the API returns it: stored fields plus what is derived on read. */
export interface ScheduledTaskView extends ScheduledTask {
  nextRunAt: string | null;
  lastRun: ScheduledRun | null;
  /** Finished runs whose session the user has not opened yet. */
  unreadRuns: number;
}

export class ScheduledTaskValidationError extends Error {
  readonly code = "validation";
  /** i18n key (`scheduled.error.*`) and parameters for the reader's language; `message` is the English fallback. */
  constructor(message: string, readonly key?: string, readonly params?: MessageParams) {
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
  | { type: "run_started"; taskId: string; taskName: string; runId: string; sessionId?: string; trigger: RunTrigger }
  | {
      type: "run_finished";
      taskId: string;
      taskName: string;
      runId: string;
      sessionId?: string;
      trigger: RunTrigger;
      status: RunStatus;
      error?: string;
      errorCode?: RunErrorCode;
      errorParams?: MessageParams;
      /** This run's failure was the one that paused the task. */
      autoPaused?: boolean;
    }
  | { type: "run_skipped"; taskId: string; runId: string; skipReason: RunSkipReason }
  /** The run is waiting for an answer to an extension dialog that nobody is there to give. */
  | { type: "run_attention"; taskId: string; taskName: string; runId: string; sessionId?: string }
  | { type: "scheduler_owner"; owner: boolean };
