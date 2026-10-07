import { getToolNamesForPreset } from "../tool-presets";
import type { RunStatus, RunTrigger, ScheduledTask } from "./types";

/** Custom session entry that marks a session as the output of a scheduled run. */
export const SCHEDULED_RUN_ENTRY_TYPE = "pi-web:scheduled-run";

/** What the runner needs from an AgentSessionWrapper; tests substitute a stub. */
export interface RunnerSession {
  send(command: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  inner: { sessionManager: { appendCustomEntry(customType: string, data: unknown): unknown } };
}

export interface RunnerDeps {
  startSession(
    cwd: string,
    options: {
      toolNames: string[];
      initialModel?: { provider: string; modelId: string };
      thinkingLevel?: string;
      allowInitialModelFallback: boolean;
    },
  ): Promise<{ session: RunnerSession; sessionId: string }>;
  now(): Date;
  /** Override of task.maxDurationMin, for tests. */
  durationMs?: number;
  /** How long to wait for the run to wind down after an abort. */
  abortGraceMs?: number;
}

export interface RunOutcome {
  status: Extract<RunStatus, "succeeded" | "failed" | "aborted">;
  error?: string;
  sessionId?: string;
  /** False when the failure says nothing about the task itself. */
  countsAsFailure: boolean;
}

const DEFAULT_ABORT_GRACE_MS = 30_000;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function runSessionName(task: ScheduledTask, at: Date): string {
  return `${task.name} · ${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one task in a brand-new session and report how it ended.
 *
 * `onSessionReady` fires as soon as the session exists, so the caller can show
 * the run (and link to its session) while it is still going.
 */
export async function executeRun(
  task: ScheduledTask,
  info: { runId: string; trigger: RunTrigger; scheduledFor?: string },
  deps: RunnerDeps,
  onSessionReady?: (sessionId: string) => void,
): Promise<RunOutcome> {
  const toolNames = getToolNamesForPreset(task.toolPreset) ?? [];
  let sessionId: string | undefined;
  let unsubscribe: (() => void) | undefined;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    const started = await deps.startSession(task.cwd, {
      toolNames,
      ...(task.model ? { initialModel: task.model } : {}),
      ...(task.thinkingLevel ? { thinkingLevel: task.thinkingLevel } : {}),
      allowInitialModelFallback: true,
    });
    const { session } = started;
    sessionId = started.sessionId;

    session.inner.sessionManager.appendCustomEntry(SCHEDULED_RUN_ENTRY_TYPE, {
      version: 1,
      taskId: task.id,
      runId: info.runId,
      taskName: task.name,
      trigger: info.trigger,
      ...(info.scheduledFor ? { scheduledFor: info.scheduledFor } : {}),
    });
    // A missing title only costs a less readable sidebar row.
    await session.send({ type: "set_session_name", name: runSessionName(task, deps.now()) }).catch(() => undefined);
    onSessionReady?.(sessionId);

    let resolveDone!: () => void;
    const promptDone = new Promise<void>((resolve) => { resolveDone = resolve; });
    let lastAssistant: Record<string, unknown> | undefined;
    let promptError: string | undefined;
    unsubscribe = session.onEvent((event) => {
      if (event.type === "message_end") {
        const message = event.message as Record<string, unknown> | undefined;
        if (message?.role === "assistant") lastAssistant = message;
      } else if (event.type === "prompt_error") {
        promptError = typeof event.errorMessage === "string" ? event.errorMessage : "Prompt failed";
      } else if (event.type === "prompt_done") {
        resolveDone();
      }
    });

    // send() resolves once the prompt is accepted; the run itself ends with prompt_done.
    await session.send({ type: "prompt", message: task.prompt });

    let timedOut = false;
    const durationMs = deps.durationMs ?? task.maxDurationMin * 60_000;
    const gaveUp = new Promise<void>((resolve) => {
      abortTimer = setTimeout(() => {
        timedOut = true;
        void session.send({ type: "abort" }).catch(() => undefined);
        graceTimer = setTimeout(resolve, deps.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS);
      }, durationMs);
    });
    await Promise.race([promptDone, gaveUp]);

    if (timedOut) {
      return {
        status: "aborted",
        error: `Stopped after reaching the ${task.maxDurationMin} minute limit`,
        sessionId,
        countsAsFailure: true,
      };
    }
    if (promptError) return { status: "failed", error: promptError, sessionId, countsAsFailure: true };
    const stopReason = lastAssistant?.stopReason;
    if (stopReason === "error") {
      const message = typeof lastAssistant?.errorMessage === "string" ? lastAssistant.errorMessage : "Model request failed";
      return { status: "failed", error: message, sessionId, countsAsFailure: true };
    }
    if (stopReason === "aborted") {
      return { status: "aborted", error: "Stopped by the user", sessionId, countsAsFailure: false };
    }
    return { status: "succeeded", sessionId, countsAsFailure: false };
  } catch (error) {
    return { status: "failed", error: errorText(error), ...(sessionId ? { sessionId } : {}), countsAsFailure: true };
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
    if (graceTimer) clearTimeout(graceTimer);
    unsubscribe?.();
  }
}
