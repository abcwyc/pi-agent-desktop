import type { ReactNode } from "react";
import type { TodoPanelState, TodoStatus } from "@/lib/todo-state";

const STATUS_GLYPH: Record<TodoStatus, ReactNode> = {
  pending: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8" />
    </svg>
  ),
  in_progress: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 0-8 8h8z" fill="currentColor" stroke="none" />
    </svg>
  ),
  completed: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  ),
};

const STATUS_COLOR: Record<TodoStatus, string> = {
  pending: "var(--text-dim)",
  in_progress: "var(--accent)",
  completed: "var(--text-dim)",
};

/**
 * Left-nav panel showing the active session's todo plan (the state the
 * `@99percentpeople/pi-todo` extension persists in the session file). Renders
 * the same status glyphs as the TUI widget (empty circle / half-filled circle /
 * checkmark). Completed tasks the extension already dropped from its lean live
 * plan are re-inserted at their original position by the reader, so the list
 * stays one ordered T1→T5 plan with finished items struck through. The header
 * reuses the project-tree header classes so it matches the rest of the
 * sidebar. Hidden when the session has no plan.
 */
export function TodoPanel({ state }: { state: TodoPanelState | null }) {
  const tasks = state?.tasks ?? [];
  if (tasks.length === 0) return null;

  const completed = tasks.filter((task) => task.status === "completed").length;

  return (
    <div
      className="sidebar-todo-panel"
      style={{
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderTop: "1px solid var(--border)",
      }}
    >
      <div className="sidebar-section-header">
        <span className="sidebar-section-title">Todo</span>
        <div className="sidebar-section-tools">
          <span
            style={{
              color: "var(--text-dim)",
              fontSize: 10.5,
              fontWeight: 500,
              letterSpacing: 0,
            }}
          >
            {completed}/{tasks.length}
          </span>
          {typeof state?.revision === "number" && (
            <span style={{ color: "var(--text-dim)", fontSize: 10, textTransform: "none" }}>
              rev {state.revision}
            </span>
          )}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          padding: "0 4px 6px",
          gap: 1,
          maxHeight: "min(38vh, 320px)",
          overflowY: "auto",
        }}
      >
        {tasks.map((task) => {
          const status = task.status ?? "pending";
          const completedTask = status === "completed";
          return (
            <div
              key={task.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "2px 6px",
                borderRadius: 4,
                fontSize: 11,
                fontFamily: "var(--font-mono)",
              }}
            >
              <span
                style={{
                  color: STATUS_COLOR[status],
                  flexShrink: 0,
                  width: 14,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {STATUS_GLYPH[status]}
              </span>
              <span
                style={{
                  color: completedTask ? "var(--text-dim)" : "var(--text)",
                  textDecoration: completedTask ? "line-through" : undefined,
                  opacity: status === "pending" ? 0.72 : 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flexShrink: 1,
                  minWidth: 0,
                }}
                // Native tooltip: the row text is ellipsis-truncated, so show
                // the full subject on hover (widget tasks have no description).
                title={task.subject ?? task.key}
              >
                {task.subject ?? task.key}
              </span>
              {task.dependsOn && task.dependsOn.length > 0 && (
                <span
                  style={{
                    color: "var(--text-dim)",
                    flexShrink: 0,
                    fontSize: 10,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 110,
                  }}
                >
                  ← {task.dependsOn.join(", ")}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
