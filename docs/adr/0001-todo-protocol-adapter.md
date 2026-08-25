# 0001: Todo panel reads a desktop-owned protocol object (read-only)

Status: superseded by ADR-0002.

Third-party pi extensions ship todo tools with incompatible state shapes and no
shared protocol (pi defines none), and the desktop cannot render their TUI
widgets over RPC anyway. We decided the desktop defines a canonical `TodoState`
protocol object and a read-only adapter layer normalizes any todo-like tool's
persisted output into it; the left-nav panel renders only that object.

## Rejected alternatives

- **Depends on one extension's schema** — couples the panel to `@99percentpeople/pi-todo`'s v2 shape; breaks silently on any schema bump.
- **Desktop registers its own `todo` tool (write path)** — any built-in `todo` collides with extension tools ("first registration per name wins"), and a writer is out of scope: the goal is to consume heterogeneous extensions, not compete with them.
- **LLM classifies/maps on every turn** — the panel is a hot path; detection is a deterministic name/description/schema scan, and LLM normalization is reserved only as a fallback for unknown formats (cached per tool name).

Superseded because the adapter layer proved unneeded: extensions can emit the
protocol directly, so the desktop drops adapters, detection, and LLM entirely
(see ADR-0002).
