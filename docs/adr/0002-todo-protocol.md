# 0002: Todo panel is a public opt-in protocol (extensions conform)

pi-agent-desktop declares a public todo protocol — `customType: "todo"` custom
message carrying a canonical `TodoState` in `details` — and a panel that renders
only that protocol. Extensions that want their todo state shown modify their own
source to emit it; the desktop does no parsing, no adapter, no LLM, and no
hook/bridge. (Supersedes the adapter-layer approach in ADR-0001.)

## Contract

`pi.sendMessage({ customType: "todo", content: "", display: false, details: { tasks } }, { triggerTurn: false })`.

Data goes in `details` because `convertToLlm` reads only `content` — the state
never enters the LLM context, and `content: ""` leaves the model at most a
harmless empty `user` message. `custom_message` entries reach the desktop's
message list with `details` intact, so the panel reads them live with zero
desktop changes. `triggerTurn: false` persists immediately without steering the
agent or starting a new turn. Docs: `docs/todo-protocol.md`; reference:
`examples/todo-extension.ts`.

## Minimal by design

The contract is intentionally minimal. The desktop panel is a read-only
renderer, so the only enforced shape is `tasks: { key, subject?, status? }[]`;
the reader tolerates and ignores every other field (`revision`, `version`,
`schemaVersion`, `protocolVersion`, `dependsOn`, `description`, ...). There is
no `revision` requirement and no dependency graph — a read-only panel needs no
optimistic-concurrency counter and no prerequisite rendering to draw a checkbox
list. This keeps third-party adoption to a single `sendMessage` call with the
extension's own native state, no mapping. (If the desktop ever grows a
write-back path — panel toggles driving the extension — that is when a revision
counter and a real concurrency story would be added.)

## Rejected alternatives

- **Desktop parses known extension schemas (adapters)** — couples the panel to formats it doesn't own; dead code without a consumer.
- **LLM discovers/maps unknown formats** — nondeterministic, a hot-path dependency, and the user rejected it as unpalatable.
- **User hook script bridges extensions** — works but is per-setup maintenance; the desktop still depends on a bridge someone must write.
- **appendEntry custom entries** — truly context-free, but `custom` entries are dropped from the desktop's message list, requiring a desktop read-path change for no benefit over `sendMessage`.
