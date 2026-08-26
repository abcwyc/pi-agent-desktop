import type { TodoPanelState, TodoStatus } from "@/lib/todo-state";

const STATUS_GLYPH: Record<TodoStatus, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "✓",
};

const STATUS_COLOR: Record<TodoStatus, string> = {
  pending: "var(--text-dim)",
  in_progress: "var(--accent)",
  completed: "var(--text-dim)",
};

/**
 * Left-nav panel showing the active session's todo plan (the state the
 * `@99percentpeople/pi-todo` extension persists in the session file). Renders
 * the same ○ / ◐ / ✓ status glyphs as the TUI widget. Completed tasks the
 * extension already dropped from its lean live plan are re-inserted at their
 * original position by the reader, so the list stays one ordered T1→T5 plan
 * with finished items struck through. Hidden when the session has no plan.
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
        maxHeight: "min(38vh, 320px)",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px 4px",
          color: "var(--text-muted)",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          flexShrink: 0,
        }}
      >
        <span>Todo</span>
        <span style={{ color: "var(--text-dim)", fontWeight: 500, letterSpacing: 0 }}>
          {completed}/{tasks.length}
        </span>
        <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, textTransform: "none" }}>
          {typeof state?.revision === "number" ? `rev ${state.revision}` : ""}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", padding: "0 4px 6px", gap: 1 }}>
        {tasks.map((task) => {
          const status = task.status ?? "pending";
          const completedTask = status === "completed";
          return (
            <div
              key={task.key}
              title={task.description}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 6,
                padding: "2px 6px",
                borderRadius: 4,
                fontSize: 11,
                fontFamily: "var(--font-mono)",
              }}
            >
              <span style={{ color: STATUS_COLOR[status], flexShrink: 0, width: 12, textAlign: "center" }}>
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
