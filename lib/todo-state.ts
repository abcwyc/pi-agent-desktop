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

/** Custom-message type pi uses for compaction summaries in the UI message list. */
const COMPACTION_CUSTOM_TYPE = "compaction";

/**
 * Derived panel state: one sequential todo list, completed tasks kept inline.
 *
 * The todo-mini extension drops completed tasks from its live plan at the next
 * turn's `before_agent_start`, so a plan of 5 that completed 2 shows only 3
 * remaining. That keeps the LLM's context lean, but it erases the user's
 * progress signal. This reader repairs the display on the read-only side: a
 * task whose last known status was `completed` but is absent from the current
 * plan is re-inserted at its original position (struck through), so the panel
 * stays one ordered T1→T5 list instead of silently shrinking. Tasks dropped
 * while still pending are scope changes, not completions, so they are not
 * re-inserted.
 *
 * A compaction summary resets the accumulated history: the pre-compaction
 * plan's work is summarized away (the extension itself emits `tasks: []`
 * right after), so its completed tasks must not be re-inserted as ghosts.
 * An empty plan without a preceding compaction (agent finished everything
 * naturally) still keeps the struck-through done list.
 *
 * Returns null only when the session has no todo protocol messages at all.
 */
export interface TodoPanelState {
  /** Optional extension-owned counter, forwarded from the latest snapshot. */
  revision?: number;
  /** The session's todo list, in first-appearance order. Completed tasks that
   * were dropped from the live plan are re-inserted with status "completed". */
  tasks: TodoTask[];
}

export function extractTodoPanelState(
  messages: readonly AgentMessage[],
): TodoPanelState | null {
  let latest: TodoState | null = null;
  // Each task's last-known snapshot, plus the order its key first appeared.
  // Both are scoped to the current compaction segment: a compaction summary
  // clears them so pre-compaction tasks never leak into the post-compact plan.
  const lastTaskByKey = new Map<string, TodoTask>();
  const firstSeen: string[] = [];
  for (const message of messages) {
    if (message.role !== "custom" || message.customType !== TODO_PROTOCOL_TYPE) {
      if (message.role === "custom" && message.customType === COMPACTION_CUSTOM_TYPE) {
        latest = null;
        lastTaskByKey.clear();
        firstSeen.length = 0;
      }
      continue;
    }
    const candidate = message.details;
    if (!isTodoState(candidate)) continue;
    latest = candidate;
    for (const task of candidate.tasks) {
      if (!lastTaskByKey.has(task.key)) firstSeen.push(task.key);
      lastTaskByKey.set(task.key, task);
    }
  }
  if (!latest && lastTaskByKey.size === 0) return null;
  const currentKeys = new Set((latest?.tasks ?? []).map((task) => task.key));
  const tasks: TodoTask[] = [];
  for (const key of firstSeen) {
    const task = lastTaskByKey.get(key)!;
    // Dropped from the live plan: keep only if it was completed (struck
    // through inline); a pending drop is a scope change, so it is omitted.
    if (!currentKeys.has(key) && task.status !== "completed") continue;
    tasks.push(task);
  }
  return {
    revision: latest?.revision,
    tasks,
  };
}
