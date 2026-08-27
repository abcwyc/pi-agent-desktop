/**
 * Todo widget protocol (desktop-owned, extension_ui_request / setWidget channel).
 *
 * pi defines no todo protocol and extension schemas differ, so pi-agent-desktop
 * declares one. Extensions that want their todo plan shown in the desktop's
 * panel emit a `setWidget` extension UI request with `widgetKey` =
 * `TODO_WIDGET_KEY` and the plan encoded in `widgetLines` (one JSON `TodoTask`
 * per line). This is the only channel the todo panel reads.
 *
 * The contract is intentionally minimal — the desktop only needs enough to
 * render a checkbox list, so the *only* hard requirement is `tasks` being an
 * array of `{ key, subject?, status? }` objects. Every other field extensions
 * may carry (`revision`, `version`, `schemaVersion`, `protocolVersion`,
 * `dependsOn`, `description`, ...) is ignored, never validated. The desktop is
 * a read-only renderer — it just shows the newest plan pushed by the widget.
 *
 * See docs/protocols/todo.md.
 */

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

/** Minimal canonical protocol object. Emitted as `widgetLines` on the todo widget. */
export interface TodoState {
  /** Optional extension-owned counter, shown as a "rev N" label when present. Ignored by validation. */
  revision?: number;
  tasks: TodoTask[];
}

/** Shape the todo panel renders. */
export interface TodoPanelState {
  /** Optional extension-owned counter, forwarded from the latest snapshot. */
  revision?: number;
  tasks: TodoTask[];
}

/** Desktop-reserved widget key for the todo widget protocol (`setWidget` channel). */
export const TODO_WIDGET_KEY = "pi-agent-desktop:todo";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

/**
 * Validate a candidate task against the minimal protocol shape.
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
 * Serialize a `TodoState` to widget lines for `ctx.ui.setWidget(key, lines)`.
 *
 * The `setWidget` RPC payload is a plain `string[]`, so the structured state is
 * encoded one task per line as JSON. Every line is a `TodoTask` object; a blank
 * line is ignored. Extensions emit their native tasks as-is (extra fields like
 * `description` / `dependsOn` survive the round trip and are rendered).
 */
export function serializeTodoWidgetLines(state: TodoState): string[] {
  return state.tasks.map((task) => JSON.stringify(task));
}

/**
 * Parse widget lines (the `setWidget` `widgetLines` payload) back into a
 * `TodoState`. Non-JSON / invalid-task lines are skipped; returns null when no
 * line parses to a valid task (including an empty plan, so the panel can hide).
 */
export function parseTodoWidgetLines(lines: string[] | undefined): TodoState | null {
  if (!Array.isArray(lines)) return null;
  const tasks: TodoTask[] = [];
  for (const line of lines) {
    if (typeof line !== "string" || line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isTodoState({ tasks: [parsed] })) tasks.push(parsed as TodoTask);
  }
  return tasks.length > 0 ? { tasks } : null;
}
