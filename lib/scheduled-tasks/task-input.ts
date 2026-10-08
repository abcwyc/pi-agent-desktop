import { randomUUID } from "crypto";
import { existsSync, statSync } from "fs";
import { isAbsolute } from "path";
import { CONCRETE_TOOL_PRESET_VALUES, isConcreteToolPreset } from "../tool-presets";
import { systemTimezone, validateCron } from "./cron";
import {
  DEFAULT_MAX_DURATION_MINUTES,
  MAX_DURATION_MINUTES,
  MAX_NAME_LENGTH,
  MAX_PROMPT_LENGTH,
  ScheduledTaskValidationError,
  type ScheduledTask,
  type ScheduledThinkingLevel,
  type TaskSchedule,
} from "./types";

const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const WRITE_PRESETS = new Set<string>(["default", "full"]);

function fail(message: string, key?: string, params?: Record<string, string | number>): never {
  throw new ScheduledTaskValidationError(message, key, params);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseName(value: unknown, otherNames: readonly string[]): string {
  if (typeof value !== "string" || !value.trim()) fail("name is required");
  const name = value.trim();
  if (name.length > MAX_NAME_LENGTH) fail(`name must be at most ${MAX_NAME_LENGTH} characters`);
  if (otherNames.some((other) => other.trim().toLowerCase() === name.toLowerCase())) {
    fail(`a task named "${name}" already exists`, "scheduled.error.nameTaken", { name });
  }
  return name;
}

function parsePrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) fail("prompt is required");
  if (value.length > MAX_PROMPT_LENGTH) fail(`prompt must be at most ${MAX_PROMPT_LENGTH} characters`);
  return value.trim();
}

function parseCwd(value: unknown): string {
  if (typeof value !== "string" || !value || !isAbsolute(value)) fail("cwd must be an absolute path");
  if (!existsSync(value) || !statSync(value).isDirectory()) {
    fail(`Directory does not exist: ${value}`, "scheduled.error.cwdMissing", { path: value });
  }
  return value;
}

export function parseSchedule(value: unknown, now: Date): TaskSchedule {
  if (!isRecord(value)) fail("schedule is required");
  if (value.kind === "manual") return { kind: "manual" };
  if (value.kind === "cron") {
    if (typeof value.expr !== "string" || !value.expr.trim()) fail("schedule.expr is required");
    const timezone = value.timezone === undefined ? systemTimezone() : value.timezone;
    if (typeof timezone !== "string" || !timezone) fail("schedule.timezone must be a string");
    const expr = value.expr.trim().split(/\s+/).join(" ");
    validateCron(expr, timezone, now);
    return { kind: "cron", expr, timezone };
  }
  if (value.kind === "once") {
    const at = typeof value.at === "string" ? new Date(value.at) : null;
    if (!at || Number.isNaN(at.getTime())) fail("schedule.at must be an ISO date");
    if (at.getTime() <= now.getTime()) fail("schedule.at must be in the future", "scheduled.error.oncePast");
    return { kind: "once", at: at.toISOString() };
  }
  return fail("schedule.kind must be manual, cron or once");
}

function parseModel(value: unknown): ScheduledTask["model"] {
  if (value === null) return undefined;
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.modelId !== "string"
    || !value.provider || !value.modelId) {
    return fail("model must be { provider, modelId }");
  }
  return { provider: value.provider, modelId: value.modelId };
}

function parseThinking(value: unknown): ScheduledThinkingLevel | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string" || !THINKING_LEVELS.has(value)) fail("invalid thinkingLevel");
  return value as ScheduledThinkingLevel;
}

function parseMaxDuration(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_DURATION_MINUTES) {
    fail(`maxDurationMin must be an integer between 1 and ${MAX_DURATION_MINUTES}`);
  }
  return value;
}

export interface TaskInputContext {
  now: Date;
  /** Names of the other tasks, for the uniqueness check. */
  otherNames: readonly string[];
}

/**
 * Build a new task from request input. Every field is validated here, on the
 * server; the UI's own checks are a convenience only.
 */
export function buildTask(input: unknown, context: TaskInputContext): ScheduledTask {
  if (!isRecord(input)) fail("body must be an object");
  const toolPreset = input.toolPreset === undefined ? "read-only" : input.toolPreset;
  if (!isConcreteToolPreset(toolPreset)) {
    fail(`toolPreset must be one of ${CONCRETE_TOOL_PRESET_VALUES.join(", ")}`);
  }
  requireWriteAcknowledgement(toolPreset, input);

  const now = context.now.toISOString();
  const model = input.model === undefined ? undefined : parseModel(input.model);
  const thinkingLevel = input.thinkingLevel === undefined ? undefined : parseThinking(input.thinkingLevel);
  const description = typeof input.description === "string" && input.description.trim()
    ? input.description.trim()
    : undefined;
  return {
    id: randomUUID(),
    name: parseName(input.name, context.otherNames),
    ...(description ? { description } : {}),
    prompt: parsePrompt(input.prompt),
    cwd: parseCwd(input.cwd),
    schedule: parseSchedule(input.schedule, context.now),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    toolPreset,
    maxDurationMin: input.maxDurationMin === undefined
      ? DEFAULT_MAX_DURATION_MINUTES
      : parseMaxDuration(input.maxDurationMin),
    enabled: input.enabled === undefined ? true : parseEnabled(input.enabled),
    createdAt: now,
    updatedAt: now,
    // Slots before creation are not this task's to catch up on.
    lastScheduledFor: now,
    consecutiveFailures: 0,
  };
}

function parseEnabled(value: unknown): boolean {
  if (typeof value !== "boolean") fail("enabled must be a boolean");
  return value;
}

/** Unattended runs that can change files or run commands need an explicit yes. */
function requireWriteAcknowledgement(preset: string, input: Record<string, unknown>): void {
  if (WRITE_PRESETS.has(preset) && input.acknowledgeUnattendedWrites !== true) {
    fail(
      "acknowledgeUnattendedWrites: true is required for a toolPreset that can change files or run commands",
      "scheduled.error.writeAck",
    );
  }
}

/**
 * Apply an edit to an existing task. Only the fields present in `patch` change.
 * Changing the schedule or re-enabling a task restarts its catch-up window, so
 * slots that passed under the old schedule, or while it was paused, are not replayed.
 */
export function applyTaskPatch(existing: ScheduledTask, patch: unknown, context: TaskInputContext): ScheduledTask {
  if (!isRecord(patch)) fail("body must be an object");
  const next: ScheduledTask = { ...existing };
  const nowIso = context.now.toISOString();

  if (patch.name !== undefined) next.name = parseName(patch.name, context.otherNames);
  if (patch.description !== undefined) {
    if (patch.description === null || (typeof patch.description === "string" && !patch.description.trim())) {
      delete next.description;
    } else if (typeof patch.description === "string") {
      next.description = patch.description.trim();
    } else {
      fail("description must be a string");
    }
  }
  if (patch.prompt !== undefined) next.prompt = parsePrompt(patch.prompt);
  if (patch.cwd !== undefined) next.cwd = parseCwd(patch.cwd);
  if (patch.model !== undefined) {
    const model = parseModel(patch.model);
    if (model) next.model = model;
    else delete next.model;
  }
  if (patch.thinkingLevel !== undefined) {
    const level = parseThinking(patch.thinkingLevel);
    if (level) next.thinkingLevel = level;
    else delete next.thinkingLevel;
  }
  if (patch.toolPreset !== undefined) {
    if (!isConcreteToolPreset(patch.toolPreset)) {
      fail(`toolPreset must be one of ${CONCRETE_TOOL_PRESET_VALUES.join(", ")}`);
    }
    if (patch.toolPreset !== existing.toolPreset) requireWriteAcknowledgement(patch.toolPreset, patch);
    next.toolPreset = patch.toolPreset;
  }
  if (patch.maxDurationMin !== undefined) next.maxDurationMin = parseMaxDuration(patch.maxDurationMin);

  let restartWindow = false;
  if (patch.schedule !== undefined) {
    next.schedule = parseSchedule(patch.schedule, context.now);
    restartWindow = true;
    // A one-time task switches itself off once it has run. Giving it a new schedule is
    // asking for it to run again, so it comes back on (unless the same edit says otherwise).
    const finishedOnce = existing.schedule.kind === "once" && !existing.enabled && !existing.autoPausedReason;
    if (finishedOnce && patch.enabled === undefined && next.schedule.kind !== "manual") next.enabled = true;
  }
  if (patch.enabled !== undefined) {
    const enabled = parseEnabled(patch.enabled);
    if (enabled && !existing.enabled) {
      restartWindow = true;
      next.consecutiveFailures = 0;
      delete next.autoPausedReason;
    }
    next.enabled = enabled;
  }
  if (restartWindow) next.lastScheduledFor = nowIso;
  next.updatedAt = nowIso;
  return next;
}
