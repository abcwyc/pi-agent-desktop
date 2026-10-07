import { existsSync, statSync } from "fs";
import { randomUUID } from "crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { decideSlot } from "./catch-up";
import { emitScheduledTaskEvent } from "./events";
import { acquireLease, isPidAlive, releaseLease } from "./lease";
import { executeRun, type RunnerDeps, type RunOutcome } from "./runner";
import {
  appendRun,
  getTask,
  listRuns,
  listTasks,
  scheduledTasksDir,
  updateRun,
  updateTask,
} from "./store";
import {
  MAX_CONCURRENT_RUNS,
  MAX_CONSECUTIVE_FAILURES,
  isNamedError,
  type RunTrigger,
  type ScheduledRun,
  type ScheduledTask,
} from "./types";

export const DEFAULT_TICK_MS = 30_000;
/** A `running` record from another process is trusted this long past its limit. */
const ORPHAN_SLACK_MS = 5 * 60_000;

export interface SchedulerOptions {
  runnerDeps: RunnerDeps;
  agentDir?: string;
  tickMs?: number;
  pid?: number;
  /** Test seam; defaults to a real liveness probe. */
  isPidAlive?: (pid: number) => boolean;
  now?: () => Date;
}

export class RunRejectedError extends Error {
  constructor(readonly code: "already_running" | "not_found", message: string) {
    super(message);
    this.name = "RunRejectedError";
  }
}

/** Use this, not `instanceof`: see isNamedError(). */
export function isRunRejectedError(error: unknown): error is RunRejectedError {
  return isNamedError(error, "RunRejectedError");
}

export interface StartedRun {
  /** The run record, once its session exists (or the run has already ended). */
  run: ScheduledRun;
  /** Settles when the run has ended. */
  done: Promise<ScheduledRun>;
}

export class Scheduler {
  private readonly agentDir: string;
  private readonly tickMs: number;
  private readonly pid: number;
  private readonly alive: (pid: number) => boolean;
  private readonly clock: () => Date;
  private readonly active = new Map<string, Promise<ScheduledRun>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private owner = false;
  private ticking = false;

  constructor(private readonly options: SchedulerOptions) {
    this.agentDir = options.agentDir ?? getAgentDir();
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.pid = options.pid ?? process.pid;
    this.alive = options.isPidAlive ?? isPidAlive;
    this.clock = options.now ?? (() => new Date());
  }

  isOwner(): boolean {
    return this.owner;
  }

  activeRunCount(): number {
    return this.active.size;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    // The timer must not keep a finished process alive.
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.owner) releaseLease(scheduledTasksDir(this.agentDir), this.pid);
    this.owner = false;
  }

  /** One scheduling pass. Public so tests can drive time by hand. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const wasOwner = this.owner;
      this.owner = acquireLease(scheduledTasksDir(this.agentDir), {
        pid: this.pid,
        now: this.clock(),
        alive: this.alive,
      });
      if (this.owner !== wasOwner) emitScheduledTaskEvent({ type: "scheduler_owner", owner: this.owner });
      if (!this.owner) return;
      if (!wasOwner) this.recoverOrphanedRuns();
      for (const task of this.dueTasks()) await this.handleTask(task);
    } catch (error) {
      console.error("[pi-web] scheduled task tick failed:", error instanceof Error ? error.message : error);
    } finally {
      this.ticking = false;
    }
  }

  private dueTasks(): ScheduledTask[] {
    return listTasks(this.agentDir).filter((task) => task.enabled && task.schedule.kind !== "manual");
  }

  private async handleTask(task: ScheduledTask): Promise<void> {
    const now = this.clock();
    const since = new Date(task.lastScheduledFor ?? task.createdAt);
    const decision = decideSlot(task, now, since);
    if (decision.action === "none") return;

    if (decision.action === "drop") {
      if (!this.claimSlot(task, since, decision.scheduledFor)) return;
      this.recordSkipped(task, decision.scheduledFor, "app-asleep", decision.skippedSlots);
      return;
    }

    if (this.hasLiveRun(task.id)) {
      if (!this.claimSlot(task, since, decision.scheduledFor)) return;
      this.recordSkipped(task, decision.scheduledFor, "overlap", decision.skippedSlots);
      return;
    }
    // Over the cap: leave the slot unclaimed so a later tick picks it up.
    if (this.active.size >= MAX_CONCURRENT_RUNS) return;
    const claimed = this.claimSlot(task, since, decision.scheduledFor);
    if (!claimed) return;

    const started = this.begin(claimed, {
      trigger: decision.trigger,
      scheduledFor: decision.scheduledFor.toISOString(),
      skippedSlots: decision.skippedSlots,
    });
    // The run outlives this tick; its outcome is recorded by begin().
    started.done.catch(() => undefined);
  }

  /**
   * Advance `lastScheduledFor` before any run starts, only if nobody else did
   * first. Returns the task as stored, or undefined when another process won.
   */
  private claimSlot(task: ScheduledTask, since: Date, slot: Date): ScheduledTask | undefined {
    const current = getTask(task.id, this.agentDir);
    if (!current || !current.enabled) return undefined;
    if (new Date(current.lastScheduledFor ?? current.createdAt).getTime() !== since.getTime()) return undefined;
    return updateTask(task.id, (stored) => ({
      ...stored,
      lastScheduledFor: slot.toISOString(),
      // A one-time task is finished the moment its slot is claimed.
      ...(stored.schedule.kind === "once" ? { enabled: false } : {}),
    }), this.agentDir);
  }

  private recordSkipped(task: ScheduledTask, slot: Date, reason: "app-asleep" | "overlap", skippedSlots: number): void {
    const run: ScheduledRun = {
      runId: randomUUID(),
      taskId: task.id,
      trigger: "schedule",
      scheduledFor: slot.toISOString(),
      status: "skipped",
      skipReason: reason,
      ...(skippedSlots > 0 ? { skippedSlots } : {}),
    };
    appendRun(run, this.agentDir);
    emitScheduledTaskEvent({ type: "run_skipped", taskId: task.id, runId: run.runId, skipReason: reason });
    emitScheduledTaskEvent({ type: "task_changed", taskId: task.id });
  }

  /** A run record that says `running` and belongs to a process that is still going. */
  private hasLiveRun(taskId: string): boolean {
    const now = this.clock().getTime();
    return listRuns(taskId, this.agentDir).some((run) => {
      if (run.status !== "running") return false;
      if (run.pid === this.pid) return this.active.has(run.runId);
      const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : now;
      const task = getTask(taskId, this.agentDir);
      const limit = (task?.maxDurationMin ?? 30) * 60_000 + ORPHAN_SLACK_MS;
      return now - startedAt < limit && typeof run.pid === "number" && this.alive(run.pid);
    });
  }

  /** Close `running` records left by a process that died mid-run. */
  private recoverOrphanedRuns(): void {
    const endedAt = this.clock().toISOString();
    for (const task of listTasks(this.agentDir)) {
      for (const run of listRuns(task.id, this.agentDir)) {
        if (run.status !== "running") continue;
        const mine = run.pid === this.pid;
        const orphaned = mine ? !this.active.has(run.runId) : !(typeof run.pid === "number" && this.alive(run.pid));
        if (!orphaned) continue;
        updateRun(task.id, run.runId, (stored) => ({
          ...stored,
          status: "aborted",
          endedAt,
          error: "Interrupted: the app closed during the run",
          errorCode: "interrupted",
        }), this.agentDir);
      }
    }
  }

  /** Start a run now, whatever the schedule says. */
  async runNow(taskId: string): Promise<StartedRun> {
    const task = getTask(taskId, this.agentDir);
    if (!task) throw new RunRejectedError("not_found", "Task not found");
    if (this.hasLiveRun(taskId)) throw new RunRejectedError("already_running", "This task is already running");
    const started = this.begin(task, { trigger: "manual" });
    const run = await started.sessionKnown;
    return { run, done: started.done };
  }

  private begin(
    task: ScheduledTask,
    info: { trigger: RunTrigger; scheduledFor?: string; skippedSlots?: number },
  ): { done: Promise<ScheduledRun>; sessionKnown: Promise<ScheduledRun> } {
    const runId = randomUUID();
    const startedAt = this.clock().toISOString();
    const record: ScheduledRun = {
      runId,
      taskId: task.id,
      trigger: info.trigger,
      ...(info.scheduledFor ? { scheduledFor: info.scheduledFor } : {}),
      startedAt,
      status: "running",
      ...(info.skippedSlots ? { skippedSlots: info.skippedSlots } : {}),
      pid: this.pid,
    };
    appendRun(record, this.agentDir);

    let announce!: (run: ScheduledRun) => void;
    const sessionKnown = new Promise<ScheduledRun>((resolve) => { announce = resolve; });

    const done = (async (): Promise<ScheduledRun> => {
      let outcome: RunOutcome;
      if (!existsSync(task.cwd) || !statSync(task.cwd).isDirectory()) {
        outcome = {
          status: "failed",
          error: `Directory does not exist: ${task.cwd}`,
          errorCode: "cwd-missing",
          errorParams: { path: task.cwd },
          countsAsFailure: true,
        };
      } else {
        outcome = await executeRun(task, { runId, trigger: info.trigger, scheduledFor: info.scheduledFor }, this.options.runnerDeps, (sessionId) => {
          const withSession = updateRun(task.id, runId, (run) => ({ ...run, sessionId }), this.agentDir) ?? { ...record, sessionId };
          emitScheduledTaskEvent({ type: "run_started", taskId: task.id, taskName: task.name, runId, sessionId, trigger: info.trigger });
          announce(withSession);
        }, () => {
          // The session stays open, so the user can open it from the page and answer.
          const sessionId = listRuns(task.id, this.agentDir).find((run) => run.runId === runId)?.sessionId;
          emitScheduledTaskEvent({ type: "run_attention", taskId: task.id, taskName: task.name, runId, ...(sessionId ? { sessionId } : {}) });
        });
      }
      const finished = updateRun(task.id, runId, (run) => ({
        ...run,
        status: outcome.status,
        endedAt: this.clock().toISOString(),
        ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        ...(outcome.errorParams ? { errorParams: outcome.errorParams } : {}),
      }), this.agentDir) ?? { ...record, status: outcome.status };
      const autoPaused = this.recordOutcome(task.id, outcome);
      announce(finished);
      emitScheduledTaskEvent({
        type: "run_finished",
        taskId: task.id,
        taskName: task.name,
        runId,
        trigger: info.trigger,
        status: outcome.status,
        ...(autoPaused ? { autoPaused: true } : {}),
        ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        ...(outcome.errorParams ? { errorParams: outcome.errorParams } : {}),
      });
      emitScheduledTaskEvent({ type: "task_changed", taskId: task.id });
      return finished;
    })().finally(() => { this.active.delete(runId); });

    this.active.set(runId, done);
    return { done, sessionKnown };
  }

  /** Update the failure count. Returns whether this outcome paused the task. */
  private recordOutcome(taskId: string, outcome: RunOutcome): boolean {
    let paused = false;
    updateTask(taskId, (task) => {
      if (outcome.status === "succeeded") return { ...task, consecutiveFailures: 0 };
      if (!outcome.countsAsFailure) return task;
      const failures = task.consecutiveFailures + 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES && task.enabled) {
        paused = true;
        return {
          ...task,
          consecutiveFailures: failures,
          enabled: false,
          autoPausedReason: outcome.error ?? "unknown error",
        };
      }
      return { ...task, consecutiveFailures: failures };
    }, this.agentDir);
    return paused;
  }
}
