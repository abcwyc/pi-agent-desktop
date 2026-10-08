import type { ScheduledTaskEvent } from "./types";

type Listener = (event: ScheduledTaskEvent) => void;

const LISTENERS_KEY = Symbol.for("pi-web:scheduled-task-listeners");

// On globalThis because the scheduler is started from instrumentation and the
// SSE route lives in another module graph; a module-level Set would be two Sets.
function listeners(): Set<Listener> {
  const holder = globalThis as unknown as Record<symbol, Set<Listener> | undefined>;
  return (holder[LISTENERS_KEY] ??= new Set<Listener>());
}

export function subscribeScheduledTaskEvents(listener: Listener): () => void {
  listeners().add(listener);
  return () => { listeners().delete(listener); };
}

export function emitScheduledTaskEvent(event: ScheduledTaskEvent): void {
  for (const listener of listeners()) {
    try { listener(event); } catch { /* a broken subscriber must not stop the others */ }
  }
}
