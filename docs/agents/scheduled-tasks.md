# Scheduled tasks

Design record: [ADR 0007](../adr/0007-scheduled-tasks.md). Full spec and implementation notes:
[scheduled-tasks-spec.md](../scheduled-tasks-spec.md).

## Data
- Tasks: `~/.pi/agent/scheduled-tasks.json` (`{ version: 1, tasks }`). Written atomically
  (`writePrivateFileAtomicSync`), unknown fields and entries it cannot parse are written back
  untouched, and an unreadable file throws instead of reading as empty, so a damaged file is
  never replaced by "no tasks".
- Runs: `~/.pi/agent/scheduled-tasks/runs/<taskId>.jsonl`, newest 200 kept. `status: "running"`
  records carry the owner `pid`; a record whose process is gone is closed as `aborted` when a
  scheduler takes over.
- Lease: `~/.pi/agent/scheduled-tasks/scheduler.lock`.
- Every store function is synchronous (read-modify-write with no `await`), which makes it atomic
  within one process. Task ids become file names, so they are validated as UUIDs.

## Server (`lib/scheduled-tasks/`)
- `scheduler.ts`: a 30 s tick (so a task can start up to 30 s late), `decideSlot()` from
  `catch-up.ts`, `claimSlot()`, overlap and concurrency rules, auto-pause after 5 failures in a
  row, `runNow()`. `runner.ts` runs one task: starts a session, tags it, names it, sends the
  prompt and waits for `prompt_done`; a model error in the last reply fails the run, a manual Stop
  does not count against the task, and a run past its time limit is aborted.
- `cron.ts` wraps croner. croner works in whole seconds and leaves out a slot equal to the
  reference time, so `previousCronRun()` looks one second ahead. Only five-field expressions
  are accepted, and runs must be at least 5 minutes apart.
- `task-input.ts` is the only place input is validated. `acknowledgeUnattendedWrites` is required
  when a task is created with, or moved to, a preset that can write.
- `run-index.ts` maps `sessionId` to its run for `/api/sessions` (rebuilt after any run event, or
  after 5 s because another process can append runs).
- Routes: `app/api/scheduled-tasks/**` (list, create, edit, delete, run now, runs, seen, cron
  preview, SSE). Writes use `isApiRequestAllowed` and `hasJsonContentType` like the other settings routes.

## Client
- `hooks/useScheduledTasks.ts`: one store and one `EventSource` shared by the sidebar badge and
  the page. Events only say that something changed; the list is refetched, debounced.
- `components/scheduled/`: `ScheduledSidebarRow`, `ScheduledView` (list, detail, delete dialog),
  `ScheduledTaskEditor`, `ScheduledRunHistory`, `scheduled-helpers.ts`.
  `lib/scheduled-tasks/schedule-presets.ts` converts between the editor's presets and cron.
- AppShell shows `ScheduledView` over the chat area without unmounting the chat, and makes the
  chat `inert` meanwhile. `?view=scheduled` keeps it open across reloads. Picking a session or
  starting a new one closes it; the cold-start restore does not (`scheduledOpenRef`), and does not
  rewrite the URL. The page marks Esc as handled, or the global shortcut would stop the agent
  that is running behind it.
- Completion notifications are the existing background-completion ones (`SessionSidebar`): a
  scheduled run reads as "Finished: <task> · <time>", success or failure alike.

## Pitfalls
- Never compare errors from the scheduler with `instanceof` in a route; see the ADR.
- Tests that start runs must finish every session they hold open (`session.finish()`): a run
  keeps a time-limit timer, and a leftover one keeps the test process alive.
- `next dev` appends an agent-rules block to the repository's `AGENTS.md`; do not commit it.
- To try the whole thing without touching real data or a real model, point `PI_CODING_AGENT_DIR`
  at a scratch directory whose `models.json` names a local OpenAI-compatible endpoint.
