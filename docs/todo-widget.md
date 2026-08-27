# Todo Widget (extension point)

**Version**: unversioned. The contract is deliberately minimal and
backward-compatible — unknown extra fields are tolerated and ignored, so
consumers don't need to pin a version. Breaking changes (if any) will be
announced in the desktop release notes.

A public, desktop-owned contract for showing a todo plan in pi-agent-desktop's
left-nav panel. Extensions **opt in**: if your extension emits this widget, its
todo state renders in the desktop panel for free. If it doesn't, the desktop
ignores it entirely.

pi provides no built-in todo extension point and extension schemas differ, so
this is pi-agent-desktop's own declaration. The desktop only reads this channel
— it never parses a specific extension's schema, uses no LLM, and has no
hand-written adapters.

## Contract

Emit an **extension UI `setWidget` request** (the `extension_ui_request` RPC
channel — the only channel the panel reads) with:

| Field | Value |
|---|---|
| `widgetKey` | `"pi-agent-desktop:todo"` (`TODO_WIDGET_KEY`) |
| `widgetLines` | one JSON `TodoTask` per line (`serializeTodoWidgetLines`) |
| `widgetLines` = `undefined` | clears the live widget / hides the panel |
| `placement` | `"aboveEditor"` (default) or `"belowEditor"` |

Use the extension API:

```ts
ctx.ui.setWidget(
  TODO_WIDGET_KEY,   // "pi-agent-desktop:todo" — desktop-reserved
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

### Rules

**MUST** — hard validation, the desktop enforces these:

- `widgetLines` is a `string[]`; each line is one JSON `TodoTask`.
- Every task needs a string `key`.
- `status`, when present, must be one of `"pending" | "in_progress" | "completed"`.
- Non-JSON / blank / invalid-task lines are skipped (`parseTodoWidgetLines`).
- An empty or all-invalid payload hides the panel.

**SHOULD** — best practices, not validated but expected:

- Emit immediately after every plan write so the panel stays current.
- Pass `undefined` to clear the panel when the plan ends.
- On session open, re-emit the current plan (`session_start` restore) so the
  latest snapshot reappears. `setWidget` is **not durable** — fire-and-forget,
  never written to the session file, no progress history.

### Integrating into an existing tool

- The widget key is a `setWidget` `widgetKey` on the `extension_ui_request`
  channel — **not a tool name**. It never collides with a `todo` tool (or any
  other tool you already register).
- If you already have a todo tool (e.g. `@99percentpeople/pi-todo`), you don't
  need a separate extension: just emit this widget after every write — call
  `ctx.ui.setWidget(TODO_WIDGET_KEY, state.tasks.map(JSON.stringify))` in the
  same place your tool updates the plan, and pass `undefined` to clear.

## Why `setWidget` and not the alternatives

- **`setWidget` (extension_ui_request) reaches the panel live** — the desktop's
  `handleExtensionUiRequest` routes `widgetKey === "pi-agent-desktop:todo"` straight into the
  sidebar panel, no session round-trip.
- **Custom messages / tool results are not parsed.** The desktop deliberately
  reads no extension schema; tool results "carry the extension's own schema,
  which the desktop refuses to parse." There is no durable message channel for
  the todo panel anymore — the panel is widget-only.
- `ctx.ui.custom()` is a **no-op in RPC mode** (pi's `RpcExtensionUIRequest` has
  no `custom` variant), and `setWidget` accepts only `string[]` (component
  factories are silently dropped in RPC).

## Reference

- Contract: `lib/todo-state.ts` — `TODO_WIDGET_KEY`, `serializeTodoWidgetLines()`, `parseTodoWidgetLines()`.
- UI: `components/TodoPanel.tsx`; routing: `hooks/useAgentSession.ts` (`setWidget` case + `todoState`).
