import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";
import {
  MAX_RUNS_PER_TASK,
  type ScheduledRun,
  type ScheduledTask,
} from "./types";

/**
 * Persistence for scheduled tasks and their runs.
 *
 * Everything here is synchronous on purpose: a read-modify-write with no await
 * in the middle cannot interleave with another one in the same process. Two
 * processes (a dev server and the desktop app) can still race, which the
 * scheduler's lease and its claim-before-run step cover.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function scheduledTasksFile(agentDir = getAgentDir()): string {
  return join(agentDir, "scheduled-tasks.json");
}

export function scheduledTasksDir(agentDir = getAgentDir()): string {
  return join(agentDir, "scheduled-tasks");
}

function runsFile(agentDir: string, taskId: string): string {
  // The id becomes a file name, so it must be exactly a uuid.
  if (!UUID_PATTERN.test(taskId)) throw new Error("Invalid task id");
  return join(scheduledTasksDir(agentDir), "runs", `${taskId}.jsonl`);
}

/**
 * Runs pushed out of the capped history keep one line here: which session they made.
 * That is all the session list needs to go on hiding them. Without it each new run
 * would drop an old one from the history and an old session back into the project tree.
 */
function archiveFile(agentDir: string, taskId: string): string {
  if (!UUID_PATTERN.test(taskId)) throw new Error("Invalid task id");
  return join(scheduledTasksDir(agentDir), "runs", `${taskId}.archive.jsonl`);
}

const ARCHIVE_SUFFIX = ".archive.jsonl";

function isTask(value: unknown): value is ScheduledTask {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === "string" && UUID_PATTERN.test(task.id)
    && typeof task.name === "string"
    && typeof task.prompt === "string"
    && typeof task.cwd === "string"
    && typeof task.schedule === "object" && task.schedule !== null
    && typeof task.enabled === "boolean";
}

interface StoredFile {
  /** Fields this build does not know about, written back untouched. */
  extra: Record<string, unknown>;
  tasks: ScheduledTask[];
  /** Entries that failed validation; kept so a newer build's tasks are not lost. */
  foreign: unknown[];
}

function readStored(path: string): StoredFile {
  if (!existsSync(path)) return { extra: {}, tasks: [], foreign: [] };
  // A damaged file throws instead of reading as empty: the next write would
  // otherwise replace every task with nothing.
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid scheduled tasks file: expected an object");
  }
  const extra = { ...(parsed as Record<string, unknown>) };
  const rawTasks = extra.tasks;
  delete extra.version;
  delete extra.tasks;
  const list = Array.isArray(rawTasks) ? rawTasks : [];
  return {
    extra,
    tasks: list.filter(isTask).map((task) => ({
      ...task,
      toolPreset: task.toolPreset ?? "read-only",
      consecutiveFailures: typeof task.consecutiveFailures === "number" ? task.consecutiveFailures : 0,
    })),
    foreign: list.filter((entry) => !isTask(entry)),
  };
}

function writeStored(path: string, stored: StoredFile): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writePrivateFileAtomicSync(
    path,
    `${JSON.stringify({ ...stored.extra, version: 1, tasks: [...stored.foreign, ...stored.tasks] }, null, 2)}\n`,
  );
}

export function listTasks(agentDir = getAgentDir()): ScheduledTask[] {
  return readStored(scheduledTasksFile(agentDir)).tasks;
}

export function getTask(id: string, agentDir = getAgentDir()): ScheduledTask | undefined {
  return listTasks(agentDir).find((task) => task.id === id);
}

/**
 * Read, change and write the tasks in one step. `change` receives the current
 * tasks and returns the list to store (it may also edit them in place).
 */
export function mutateTasks<T>(
  change: (tasks: ScheduledTask[]) => { tasks: ScheduledTask[]; result: T },
  agentDir = getAgentDir(),
): T {
  const path = scheduledTasksFile(agentDir);
  const stored = readStored(path);
  const { tasks, result } = change(stored.tasks);
  writeStored(path, { ...stored, tasks });
  return result;
}

export function updateTask(
  id: string,
  change: (task: ScheduledTask) => ScheduledTask,
  agentDir = getAgentDir(),
): ScheduledTask | undefined {
  return mutateTasks((tasks) => {
    const index = tasks.findIndex((task) => task.id === id);
    if (index === -1) return { tasks, result: undefined };
    const next = [...tasks];
    next[index] = change(tasks[index]);
    return { tasks: next, result: next[index] };
  }, agentDir);
}

export function deleteTask(id: string, options: { removeRuns?: boolean } = {}, agentDir = getAgentDir()): boolean {
  const removed = mutateTasks((tasks) => {
    const next = tasks.filter((task) => task.id !== id);
    return { tasks: next, result: next.length !== tasks.length };
  }, agentDir);
  if (removed && options.removeRuns) {
    rmSync(runsFile(agentDir, id), { force: true });
    rmSync(archiveFile(agentDir, id), { force: true });
  }
  return removed;
}

function readRuns(agentDir: string, taskId: string): ScheduledRun[] {
  const path = runsFile(agentDir, taskId);
  if (!existsSync(path)) return [];
  const runs: ScheduledRun[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const run = JSON.parse(line) as ScheduledRun;
      if (typeof run.runId === "string" && run.taskId === taskId) runs.push(run);
    } catch {
      // A torn line from a crash mid-write must not hide the rest.
    }
  }
  return runs;
}

function writeRuns(agentDir: string, taskId: string, runs: ScheduledRun[]): void {
  const path = runsFile(agentDir, taskId);
  mkdirSync(join(path, ".."), { recursive: true });
  const kept = runs.slice(-MAX_RUNS_PER_TASK);
  const dropped = runs.slice(0, runs.length - kept.length).filter((run) => run.sessionId);
  if (dropped.length > 0) {
    appendFileSync(
      archiveFile(agentDir, taskId),
      dropped.map((run) => JSON.stringify({ runId: run.runId, sessionId: run.sessionId })).join("\n") + "\n",
      { mode: 0o600 },
    );
  }
  writePrivateFileAtomicSync(path, kept.map((run) => JSON.stringify(run)).join("\n") + (kept.length ? "\n" : ""));
}

function readArchive(agentDir: string, taskId: string): ScheduledRun[] {
  const path = archiveFile(agentDir, taskId);
  if (!existsSync(path)) return [];
  const archived: ScheduledRun[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { runId?: unknown; sessionId?: unknown };
      if (typeof entry.runId === "string" && typeof entry.sessionId === "string") {
        // Only the session link survives; the rest of the record is gone.
        archived.push({ runId: entry.runId, taskId, trigger: "schedule", status: "succeeded", sessionId: entry.sessionId });
      }
    } catch {
      // A torn line must not hide the rest.
    }
  }
  return archived;
}

/** Runs of a task, oldest first. */
export function listRuns(taskId: string, agentDir = getAgentDir()): ScheduledRun[] {
  return readRuns(agentDir, taskId);
}

export function appendRun(run: ScheduledRun, agentDir = getAgentDir()): void {
  writeRuns(agentDir, run.taskId, [...readRuns(agentDir, run.taskId), run]);
}

export function updateRun(
  taskId: string,
  runId: string,
  change: (run: ScheduledRun) => ScheduledRun,
  agentDir = getAgentDir(),
): ScheduledRun | undefined {
  const runs = readRuns(agentDir, taskId);
  const index = runs.findIndex((run) => run.runId === runId);
  if (index === -1) return undefined;
  runs[index] = change(runs[index]);
  writeRuns(agentDir, taskId, runs);
  return runs[index];
}

/** Every run of every task, for building the session-to-run index. */
export function listAllRuns(agentDir = getAgentDir()): ScheduledRun[] {
  const dir = join(scheduledTasksDir(agentDir), "runs");
  if (!existsSync(dir)) return [];
  const runs: ScheduledRun[] = [];
  for (const file of readdirSync(dir)) {
    if (file.endsWith(ARCHIVE_SUFFIX)) {
      const taskId = file.slice(0, -ARCHIVE_SUFFIX.length);
      if (UUID_PATTERN.test(taskId)) runs.push(...readArchive(agentDir, taskId));
      continue;
    }
    const taskId = file.replace(/\.jsonl$/, "");
    if (!UUID_PATTERN.test(taskId)) continue;
    runs.push(...readRuns(agentDir, taskId));
  }
  return runs;
}
