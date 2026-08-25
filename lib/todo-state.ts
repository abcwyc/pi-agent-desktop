import type { AgentMessage } from "./types";

/**
 * Todo protocol (desktop-owned).
 *
 * pi defines no todo protocol and extension schemas differ, so pi-agent-desktop
 * declares one. Extensions that want their todo state shown in the desktop's
 * panel emit a custom message with `customType` = `TODO_PROTOCOL_TYPE` and a
 * task list as `details` (via `sendMessage`, `display: false`).
 *
 * The contract is intentionally minimal — the desktop only needs enough to
 * render a checkbox list, so the *only* hard requirement is `tasks` being an
 * array of `{ key, subject?, status? }` objects. Every other field extensions
 * may carry (`revision`, `version`, `schemaVersion`, `protocolVersion`,
 * `dependsOn`, `description`, ...) is ignored, never validated. The desktop is
 * a read-only renderer, so it needs no revision counter for concurrency and no
 * dependency graph — it just shows the newest plan on the branch.
 *
 * See docs/todo-protocol.md, ADR 0002.
 */

export const TODO_PROTOCOL_TYPE = "todo";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoTask {
  /** Stable identity while the task remains in the plan. The only required field. */
  key: string;
  /** Display text; the panel falls back to `key` when absent. */
  subject?: string;
  /** Defaults to "pending" in the panel when absent. */
  status?: TodoStatus;
  /** Optional extra fields are tolerated but ignored by the reader. */
  description?: string;
  dependsOn?: string[];
}

/** Minimal canonical protocol object. Emitted as `details` on a `todo` custom message. */
export interface TodoState {
  /** Optional extension-owned counter, shown as a "rev N" label when present. Ignored by validation. */
  revision?: number;
  tasks: TodoTask[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

/**
 * Validate a candidate `details` against the minimal protocol shape.
 *
 * Only `tasks` (array of objects with a string `key`, optional valid `status`)
 * is enforced. Everything else is ignored, so any extension whose todo tool
 * carries a task list can emit its native state with zero transformation.
 */
function isTodoState(value: unknown): value is TodoState {
  if (!isRecord(value) || !Array.isArray(value.tasks)) return false;
  for (const task of value.tasks) {
    if (!isRecord(task) || typeof task.key !== "string") return false;
    if (task.status !== undefined && !isTodoStatus(task.status)) return false;
  }
  return true;
}

/**
 * Extract the current todo plan from a session's messages.
 *
 * Reads `todo` custom messages (`role: "custom"`, `customType: "todo"`) and
 * validates their `details` against the minimal `TodoState` shape. Messages are
 * in branch order, so the **last conforming snapshot is the current plan**.
 * Returns null when the session has no conforming todo plan.
 */
export function extractTodoState(messages: readonly AgentMessage[]): TodoState | null {
  let latest: TodoState | null = null;
  for (const message of messages) {
    if (message.role !== "custom" || message.customType !== TODO_PROTOCOL_TYPE) {
      continue;
    }
    const candidate = message.details;
    if (!isTodoState(candidate)) continue;
    latest = candidate;
  }
  return latest;
}
