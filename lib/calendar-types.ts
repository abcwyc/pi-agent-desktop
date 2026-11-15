// Wire format of GET /api/calendar (the Tasks page calendar). Plain data,
// shared by the route and the client.
import type { MessageParams, RunErrorCode, RunStatus, TaskSchedule } from "./scheduled-tasks/types";

/** One user prompt: when it was sent, its entry (for jumping to it) and a short text. */
export interface SessionPrompt {
  at: number;
  entryId: string;
  text: string;
  /** The last text reply that descends from this prompt, shortened. */
  reply?: string;
}

export interface CalendarTask {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  schedule: TaskSchedule;
  enabled: boolean;
}

export interface CalendarRun {
  runId: string;
  taskId: string;
  /** When it started, or the slot it covered if it never did (ms). */
  at: number;
  endedAt?: number;
  status: Exclude<RunStatus, "skipped">;
  sessionId?: string;
  error?: string;
  errorCode?: RunErrorCode;
  errorParams?: MessageParams;
}

export interface CalendarPlannedRun {
  taskId: string;
  at: number;
}

export interface CalendarData {
  from: number;
  to: number;
  now: number;
  /** Session id -> prompts asked in the range, oldest first. */
  prompts: Record<string, SessionPrompt[]>;
  tasks: CalendarTask[];
  runs: CalendarRun[];
  planned: CalendarPlannedRun[];
}
