import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { subscribeScheduledTaskEvents } from "./events";
import { listAllRuns } from "./store";
import type { ScheduledTaskEvent } from "./types";

export interface ScheduledSessionRun {
  taskId: string;
  runId: string;
}

/**
 * Which sessions were produced by a scheduled run. The sidebar needs this on
 * every session list, so it is built from the run files once and reused; the
 * session transcripts themselves are never opened (the incremental scanner
 * only reads entries for sessions with a parent).
 */

/** Another process can append runs without telling this one, so entries age out. */
const MAX_AGE_MS = 5_000;
const INDEX_KEY = Symbol.for("pi-web:scheduled-run-index");

interface IndexState {
  builtAt: number;
  /** Set by an event that says the run files changed. */
  stale: boolean;
  agentDir: string;
  bySession: Map<string, ScheduledSessionRun>;
  unsubscribe?: () => void;
}

function holder(): Record<symbol, IndexState | undefined> {
  return globalThis as unknown as Record<symbol, IndexState | undefined>;
}

const INVALIDATING = new Set<ScheduledTaskEvent["type"]>(["run_started", "run_finished", "task_changed"]);

export function invalidateScheduledRunIndex(): void {
  const state = holder()[INDEX_KEY];
  if (state) state.stale = true;
}

export function getScheduledSessionRuns(
  options: { agentDir?: string; now?: number } = {},
): ReadonlyMap<string, ScheduledSessionRun> {
  const agentDir = options.agentDir ?? getAgentDir();
  const now = options.now ?? Date.now();
  const existing = holder()[INDEX_KEY];
  if (existing && !existing.stale && existing.agentDir === agentDir && now - existing.builtAt < MAX_AGE_MS) {
    return existing.bySession;
  }

  const bySession = new Map<string, ScheduledSessionRun>();
  for (const run of listAllRuns(agentDir)) {
    if (run.sessionId) bySession.set(run.sessionId, { taskId: run.taskId, runId: run.runId });
  }
  const state: IndexState = {
    builtAt: now,
    stale: false,
    agentDir,
    bySession,
    // Keep one subscription across rebuilds; tests that switch agentDir reuse it too.
    unsubscribe: existing?.unsubscribe ?? subscribeScheduledTaskEvents((event) => {
      if (INVALIDATING.has(event.type)) invalidateScheduledRunIndex();
    }),
  };
  holder()[INDEX_KEY] = state;
  return bySession;
}

/** Return `sessions` with the `scheduled` relation set on every session a run produced. */
export function attachScheduledRelations<T extends { id: string; relation?: unknown }>(
  sessions: readonly T[],
  runs: ReadonlyMap<string, ScheduledSessionRun> = getScheduledSessionRuns(),
): T[] {
  if (runs.size === 0) return sessions as T[];
  return sessions.map((session) => {
    const run = runs.get(session.id);
    if (!run) return session;
    return { ...session, relation: { kind: "scheduled" as const, taskId: run.taskId, runId: run.runId } };
  });
}
