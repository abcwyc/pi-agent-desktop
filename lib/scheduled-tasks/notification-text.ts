import { describeRunError } from "./run-error";
import type { ScheduledTaskEvent } from "./types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface RunNotification {
  title: string;
  body: string;
  /** One notification per run and kind, so a repeat replaces the first instead of stacking. */
  tag: string;
  sessionId?: string;
  /** Play the completion sound: only for a run that went well. */
  sound: boolean;
}

const MAX_ERROR_LENGTH = 140;

/** First line of an error, trimmed to fit a notification. */
export function shortError(error: string | undefined): string {
  const line = (error ?? "").split("\n").find((text) => text.trim()) ?? "";
  const text = line.trim();
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

/**
 * What to tell the user about a run event, or null when it is not worth a
 * notification: runs that merely started, skipped slots, and runs the user
 * stopped by hand.
 */
export function describeRunNotification(event: ScheduledTaskEvent, t: Translate): RunNotification | null {
  if (event.type === "run_started") {
    if (event.trigger !== "catch-up") return null;
    return {
      title: t("scheduled.notify.catchUp"),
      body: event.taskName,
      tag: `pi-scheduled:${event.runId}:start`,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      sound: false,
    };
  }
  if (event.type === "run_attention") {
    return {
      title: t("scheduled.notify.attention"),
      body: event.taskName,
      tag: `pi-scheduled:${event.runId}:attention`,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      sound: false,
    };
  }
  if (event.type !== "run_finished") return null;

  const base = {
    tag: `pi-scheduled:${event.runId}:end`,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
  };
  const withError = (name: string) => {
    // An error with a code is already a short sentence; a provider's message can be long.
    const detail = event.errorCode ? describeRunError(event, t) : shortError(event.error);
    return detail ? `${name} — ${detail}` : name;
  };
  const pausedNote = event.autoPaused ? ` ${t("scheduled.notify.pausedNote")}` : "";

  switch (event.status) {
    case "succeeded":
      return { ...base, title: t("scheduled.notify.succeeded"), body: event.taskName, sound: true };
    case "failed":
      return { ...base, title: t("scheduled.notify.failed"), body: `${withError(event.taskName)}${pausedNote}`, sound: false };
    case "aborted":
      if (event.errorCode === "stopped") return null;
      return { ...base, title: t("scheduled.notify.stopped"), body: `${withError(event.taskName)}${pausedNote}`, sound: false };
    default:
      return null;
  }
}
