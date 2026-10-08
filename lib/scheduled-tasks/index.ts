import { Scheduler } from "./scheduler";
import { liveRunnerDeps } from "./runtime";

export * from "./types";
export { subscribeScheduledTaskEvents, emitScheduledTaskEvent } from "./events";
export { RunRejectedError, Scheduler, isRunRejectedError } from "./scheduler";

const SCHEDULER_KEY = Symbol.for("pi-web:scheduler");

/**
 * The process-wide scheduler. Held on globalThis because instrumentation (which
 * starts it) and the route handlers (which use it) are separate module graphs.
 */
export function getScheduler(): Scheduler {
  const holder = globalThis as unknown as Record<symbol, Scheduler | undefined>;
  return (holder[SCHEDULER_KEY] ??= new Scheduler({ runnerDeps: liveRunnerDeps }));
}

export function startScheduler(): Scheduler {
  const scheduler = getScheduler();
  scheduler.start();
  return scheduler;
}
