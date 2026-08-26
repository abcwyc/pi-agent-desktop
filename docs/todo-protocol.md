# Todo Widget Protocol

A public, desktop-owned contract for showing a todo plan in pi-agent-desktop's
left-nav panel. Extensions **opt in**: if your extension emits this protocol, its
todo state renders in the desktop panel for free. If it doesn't, the desktop
ignores it entirely.

pi provides no todo protocol and extension schemas differ, so this is
pi-agent-desktop's own declaration. The desktop only reads this protocol — it
never parses a specific extension's schema, uses no LLM, and has no hand-written
adapters.

## Contract

Emit an **extension UI `setWidget` request** (the `extension_ui_request` RPC
channel — the only channel the panel reads) with:

| Field | Value |
|---|---|
| `widgetKey` | `"todo"` (`TODO_WIDGET_KEY`) |
| `widgetLines` | one JSON `TodoTask` per line (`serializeTodoWidgetLines`) |
| `widgetLines` = `undefined` | clears the live widget / hides the panel |
| `placement` | `"aboveEditor"` (default) or `"belowEditor"` |

Use the extension API:

```ts
ctx.ui.setWidget(
  TODO_WIDGET_KEY,   // "todo" — desktop-reserved
  state.tasks.map((task) => JSON.stringify(task)),   // [{ key, subject?, status? }]
  { placement: "aboveEditor" },
);
```

### TodoState shape (minimal)

```ts
interface TodoTask {
  key: string;               // stable identity while the task remains in the plan — the only required field
  subject?: string;          // display text (fall back to key)
  status?: "pending" | "in_progress" | "completed";  // default "pending"
}

interface TodoState {
  tasks: TodoTask[];         // `[]` clears the plan
}
```

The contract is intentionally minimal: the desktop is a read-only renderer, so it
only needs a task list to draw. Any extra fields an extension carries (`revision`,
`version`, `schemaVersion`, `protocolVersion`, `description`, `dependsOn`, ...)
are **tolerated and ignored** — never validated, never required. Emit your
native tasks as-is; no mapping needed.

### Rules (mirror the desktop's validation)

- `widgetLines` is a `string[]`; each line is one JSON `TodoTask`.
- Non-JSON / blank / invalid-task lines are skipped (`parseTodoWidgetLines`).
- An empty or all-invalid payload hides the panel.
- Every task needs a string `key`; `status`, when present, must be one of the three values.
- **Not durable.** `setWidget` is fire-and-forget — it is never written to the
  session file and carries no progress history. The panel shows the latest
  snapshot only. On session open the extension's `session_start` restore re-emits
  the current plan, so the latest snapshot reappears.

## Why `setWidget` and not the alternatives

- **`setWidget` (extension_ui_request) reaches the panel live** — the desktop's
  `handleExtensionUiRequest` routes `widgetKey === "todo"` straight into the
  sidebar panel, no session round-trip.
- **Custom messages / tool results are not parsed.** The desktop deliberately
  reads no extension schema; tool results "carry the extension's own schema,
  which the desktop refuses to parse." There is no durable message channel for
  the todo panel anymore — the panel is widget-only.
- `ctx.ui.custom()` is a **no-op in RPC mode** (pi's `RpcExtensionUIRequest` has
  no `custom` variant), and `setWidget` accepts only `string[]` (component
  factories are silently dropped in RPC).

## Reference

- Protocol: `lib/todo-state.ts` — `TODO_WIDGET_KEY`, `serializeTodoWidgetLines()`, `parseTodoWidgetLines()`.
- UI: `components/TodoPanel.tsx`; routing: `hooks/useAgentSession.ts` (`setWidget` case + `todoState`).
- Working example: `examples/todo-extension.ts` — copy to `~/.pi/agent/extensions/`.
