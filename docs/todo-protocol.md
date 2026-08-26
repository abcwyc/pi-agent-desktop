# Todo Protocol

A public, desktop-owned contract for showing a todo plan in pi-agent-desktop's
left-nav panel. Extensions **opt in**: if your extension emits this protocol, its
todo state renders in the desktop panel for free. If it doesn't, the desktop
ignores it entirely.

pi provides no todo protocol and extension schemas differ, so this is
pi-agent-desktop's own declaration (ADR 0002). The desktop only reads this
protocol — it never parses a specific extension's schema, uses no LLM, and has
no hand-written adapters.

## Contract

Emit a **custom message** (not a tool result, not an entry) with:

| Field | Value |
|---|---|
| `customType` | `"todo"` |
| `details` | a `TodoState` object (below) |
| `content` | `""` or a minimal marker (it becomes a `user` message in LLM context, so keep it empty — the data lives in `details`, which never enters context) |
| `display` | `false` |
| `options` | `{ triggerTurn: false }` (or omit the options — avoid `triggerTurn: true` / `deliverAs: "steer"` / `deliverAs: "followUp"`, which force it into the agent's active turn or start a new one; `nextTurn` only attaches to the next user prompt) |

Use the extension API:

```ts
pi.sendMessage({
  customType: "todo",
  content: "",
  display: false,
  details: todoState,      // { tasks: TodoTask[] }
}, { triggerTurn: false });
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
native state as-is; no mapping needed.

### Rules (mirror the desktop's validation)

- `tasks` must be an array.
- Every task needs a string `key`; `status`, when present, must be one of the three values.
- Messages are in branch order, so the desktop picks the **last conforming** plan as current; earlier ones are history.
- The panel hides only when the session has no plan. The extension drops completed tasks at the next turn's `before_agent_start` (to keep the LLM's context lean); the desktop's reader re-inserts them at their original position struck-through (`extractTodoPanelState`), so the list stays one ordered T1→T5 plan and progress survives across turns. A **compaction summary resets the accumulated history** (pre-compaction tasks are never re-inserted as ghosts); a natural empty plan (all tasks finished, no compaction) still keeps the struck-through done list.

## Why `sendMessage` + `details` and not the alternatives

- **`details` carries the data** — `convertToLlm` only reads `content`, so the
  canonical state never enters the LLM context. `content` stays empty so the
  model sees at most a harmless empty `user` message.
- **`custom_message` entries reach the desktop** — the desktop's
  `entryToUiMessage` maps them into `messages` with `details` intact, so the
  panel reads them live with zero desktop changes.
- Not `appendEntry` (`custom` entries are excluded from the desktop's message
  list) and not a tool result (tool results carry the extension's own schema,
  which the desktop refuses to parse).

## Reference

- Reader: `lib/todo-state.ts` — `extractTodoPanelState()` (single ordered list, completed re-inserted; resets at compaction summaries), `extractTodoState()` (raw current plan), `TODO_PROTOCOL_TYPE`.
- UI: `components/TodoPanel.tsx`.
- Working example: `examples/todo-extension.ts` — copy to `~/.pi/agent/extensions/`.
- Decision history: `docs/adr/0002-todo-protocol.md`.
