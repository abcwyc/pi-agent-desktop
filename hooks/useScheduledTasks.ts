"use client";

import { useSyncExternalStore } from "react";
import { scheduledApi } from "@/lib/scheduled-tasks/client";
import type { ScheduledTaskEvent, ScheduledTaskView } from "@/lib/scheduled-tasks/types";

export interface ScheduledTasksState {
  tasks: ScheduledTaskView[];
  loaded: boolean;
  error: string | null;
  /** False when another process holds the scheduler lease and this one will not fire tasks. */
  schedulerOwner: boolean | null;
  /** Task ids with a run in progress, from the event stream. */
  runningTaskIds: ReadonlySet<string>;
}

const INITIAL: ScheduledTasksState = {
  tasks: [],
  loaded: false,
  error: null,
  schedulerOwner: null,
  runningTaskIds: new Set(),
};

/**
 * One store and one EventSource shared by the sidebar badge and the Scheduled
 * view. The stream only says that something changed; the list is refetched
 * (debounced) rather than patched from event payloads.
 */
let state = INITIAL;
const listeners = new Set<() => void>();
let source: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let refetchTimer: ReturnType<typeof setTimeout> | null = null;
let loadId = 0;
/** Raw events, for consumers that act on them (notifications) rather than on the list. */
const eventHandlers = new Set<(event: ScheduledTaskEvent) => void>();
/** Sessions known to be produced by a scheduled run, from events and from each task's latest run. */
const scheduledSessionIds = new Set<string>();

function setState(next: Partial<ScheduledTasksState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export async function refreshScheduledTasks(): Promise<void> {
  const id = ++loadId;
  try {
    const data = await scheduledApi.list();
    if (id !== loadId) return;
    for (const task of data.tasks) {
      if (task.lastRun?.sessionId) scheduledSessionIds.add(task.lastRun.sessionId);
    }
    setState({ tasks: data.tasks, loaded: true, error: null, schedulerOwner: data.scheduler.owner });
  } catch (error) {
    if (id !== loadId) return;
    setState({ loaded: true, error: error instanceof Error ? error.message : String(error) });
  }
}

function scheduleRefetch(): void {
  if (refetchTimer) return;
  refetchTimer = setTimeout(() => {
    refetchTimer = null;
    void refreshScheduledTasks();
  }, 150);
}

function handleEvent(event: ScheduledTaskEvent): void {
  if ((event.type === "run_started" || event.type === "run_finished") && event.sessionId) {
    scheduledSessionIds.add(event.sessionId);
  }
  for (const handler of eventHandlers) {
    try { handler(event); } catch { /* one consumer failing must not starve the others */ }
  }
  if (event.type === "scheduler_owner") {
    setState({ schedulerOwner: event.owner });
    return;
  }
  if (event.type === "run_started") {
    setState({ runningTaskIds: new Set([...state.runningTaskIds, event.taskId]) });
  } else if (event.type === "run_finished") {
    const next = new Set(state.runningTaskIds);
    next.delete(event.taskId);
    setState({ runningTaskIds: next });
  }
  scheduleRefetch();
}

function connect(): void {
  if (source || typeof EventSource === "undefined") return;
  const stream = new EventSource("/api/scheduled-tasks/events");
  source = stream;
  stream.onopen = () => { void refreshScheduledTasks(); };
  stream.onmessage = (message) => {
    try { handleEvent(JSON.parse(message.data) as ScheduledTaskEvent); } catch { /* ignore a malformed frame */ }
  };
  stream.onerror = () => {
    // EventSource retries by itself unless the browser closed it for good.
    if (stream.readyState !== EventSource.CLOSED) return;
    source = null;
    if (listeners.size > 0 && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (listeners.size > 0) connect();
      }, 3000);
    }
  };
}

function disconnect(): void {
  source?.close();
  source = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (refetchTimer) clearTimeout(refetchTimer);
  refetchTimer = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    connect();
    void refreshScheduledTasks();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) disconnect();
  };
}

/** Listen to every event. The stream must be held open separately; see retainScheduledTaskStream(). */
export function onScheduledTaskEvent(handler: (event: ScheduledTaskEvent) => void): () => void {
  eventHandlers.add(handler);
  return () => { eventHandlers.delete(handler); };
}

/** Keep the event stream open without subscribing to list state. Returns the release function. */
export function retainScheduledTaskStream(): () => void {
  return subscribe(() => undefined);
}

/** Whether a session is the output of a scheduled run, as far as this window has heard. */
export function isScheduledRunSession(sessionId: string): boolean {
  return scheduledSessionIds.has(sessionId);
}

const getSnapshot = () => state;
const getServerSnapshot = () => INITIAL;

export function useScheduledTasks(): ScheduledTasksState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Totals for the sidebar row. */
export function summarizeScheduledTasks(tasks: readonly ScheduledTaskView[], running: ReadonlySet<string>) {
  return {
    unread: tasks.reduce((total, task) => total + task.unreadRuns, 0),
    running: running.size > 0,
    attention: tasks.some((task) => Boolean(task.autoPausedReason)),
  };
}
