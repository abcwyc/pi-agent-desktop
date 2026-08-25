# Pi Agent Desktop — Extension UI

Glossary for how pi-agent-desktop surfaces the extension-UI domain of pi's agent
runtime over in-process RPC sessions. This repo is a web/Tauri frontend, not the
interactive TUI, so only extension capabilities that survive the `rpc` mode boundary
exist here.

## Language

**Extension widget**:
A generic surface an extension attaches around the chat input via
`ctx.ui.setWidget(key, lines, { placement })`. The payload is plain text lines
(`string[]`); placement is `aboveEditor` (default) or `belowEditor`. It is **not
todo-specific** — any extension can hang any text content there. Todo lists are one
consumer that encode their own states (e.g. `[ ]` / `[~]` / `[x]`) as text lines.

`setWidget` has two content forms: a text-line array (portable — renders in both the
TUI and the desktop) and a TUI component factory (TUI-only). The desktop RPC bridge
**silently drops** component-factory widgets — `createExtensionUiContext().setWidget`
returns early when `content` is not an array. So rich interactive TUI widgets are
invisible in the desktop; only text-line widgets reach it, rendered as static text.
_Avoid_: todo panel, todo list, "the todo widget"

**Todo protocol**:
The desktop-owned public contract that shows a todo plan in the panel: a custom
message with `customType: "todo"` (a message type, not a tool name — no collision
with the `todo` tool) carrying a minimal task list in `details`, emitted via
`sendMessage` with `display: false` and `{ triggerTurn: false }`. The contract is
minimal by design — only `tasks: { key, subject?, status? }[]` is enforced; every
other field an extension carries (`revision`, `version`, `schemaVersion`,
`dependsOn`, ...) is ignored. Data lives in `details` because `convertToLlm`
reads only `content`, so the state never enters the LLM context. Extensions opt
in by conforming; the desktop parses nothing else (ADR 0002, docs/todo-protocol.md).
_Avoid_: "the pi-todo state", "the extension's schema"

**Todo panel**:
The desktop-specific left-nav surface that renders the active session's canonical
**Todo protocol** object (read-only). It is a renderer for protocol-conformant data
only — never a writer, never tied to a specific extension. Hidden when the session
has no plan.

**Extension UI request**:
The RPC event type (`extension_ui_request`) that carries extension UI operations from
the pi runtime to a headless host: dialogs (`select` / `confirm` / `input` / `editor`),
`notify`, `setStatus`, `setWidget`, `setTitle`, and `custom`.

**Extension status**:
A keyed status line an extension sets via `setStatus`. One text line per key, shown in
the footer/status area. Distinct from an extension widget.

**RPC session**:
An in-process `AgentSession` created by `startRpcSession()`. The desktop runs the agent
headless (`mode: "rpc"`) and relays extension UI to the browser over SSE. Terminal-only
capabilities (`setEditorComponent`, custom components with real keyboard focus) degrade
or no-op here.
