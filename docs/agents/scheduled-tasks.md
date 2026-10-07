# Scheduled tasks

Design record: [ADR 0007](../adr/0007-scheduled-tasks.md). Full spec and implementation notes:
[scheduled-tasks-spec.md](../scheduled-tasks-spec.md).

## Data
- Tasks: `~/.pi/agent/scheduled-tasks.json` (`{ version: 1, tasks }`). Written atomically
  (`writePrivateFileAtomicSync`), unknown fields and entries it cannot parse are written back
  untouched, and an unreadable file throws instead of reading as empty, so a damaged file is
  never replaced by "no tasks".
- Runs: `~/.pi/agent/scheduled-tasks/runs/<taskId>.jsonl`, newest 200 kept. A run pushed out of
  that history leaves one `{ runId, sessionId }` line in `<taskId>.archive.jsonl`, which the run index
  still reads: the session list hides a session by that link, so dropping it would put one old
  session back into the project tree for every new run. `status: "running"`
  records carry the owner `pid`; a record whose process is gone is closed as `aborted` when a
  scheduler takes over.
- Lease: `~/.pi/agent/scheduled-tasks/scheduler.lock`.
- Deleting a task removes its run file as well. That file is what marks the task's sessions as scheduled
  runs, so afterwards they are ordinary sessions in the project list (see the ADR).
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
- Errors in the reader's language: a validation error carries `key` and `params` (`scheduled.error.*`)
  and the API returns them; a run's own errors carry `errorCode` / `errorParams` (`RunErrorCode`:
  `time-limit`, `interrupted`, `stopped`, `cwd-missing`), turned into text by `describeRunError()`
  (`lib/scheduled-tasks/run-error.ts`) for both the history list and notifications. The English
  `error` string stays as the fallback and for provider messages, which have no code.
  `autoPausedReason` is the error of the run that paused the task; the page composes the sentence.
- `task-input.ts` is the only place input is validated. `acknowledgeUnattendedWrites` is required
  when a task is created with, or moved to, a preset that can write.
- `run-index.ts` maps `sessionId` to its run for `/api/sessions` (rebuilt after any run event, or
  after 5 s because another process can append runs).
- Routes: `app/api/scheduled-tasks/**` (list, create, edit, delete, run now, runs, seen, cron
  preview, SSE). Writes use `isApiRequestAllowed` and `hasJsonContentType` like the other settings routes.

## Client
- `hooks/useScheduledTasks.ts`: one store shared by the sidebar badge and the page, fed by
  `lib/scheduled-tasks/shared-stream.ts` (one stream per browser, led by one tab; see the ADR). Events
  only say that something changed; the list is refetched, debounced. The sidebar's running dot also
  reads each task's latest run, because events only cover runs this window saw start.
- `components/scheduled/`: `ScheduledSidebarRow`, `ScheduledView` (list, detail, delete dialog),
  `ScheduledTaskEditor`, `ScheduledRunHistory`, `scheduled-helpers.ts`.
  `lib/scheduled-tasks/schedule-presets.ts` converts between the editor's presets and cron.
- AppShell shows `ScheduledView` over the chat area without unmounting the chat, and makes the
  chat `inert` meanwhile. `?view=scheduled` keeps it open across reloads. Picking a session or
  starting a new one closes it; the cold-start restore does not (`scheduledOpenRef`), and does not
  rewrite the URL. The page marks Esc as handled, or the global shortcut would stop the agent
  that is running behind it.
- Notifications: `lib/scheduled-tasks/notification-text.ts` turns a run event into text (pure, tested),
  `hooks/useScheduledRunNotifications.ts` listens to the shared event stream and delivers it, and
  AppShell supplies the browser delivery (the same `deliverSessionNotification` that session completion
  uses; the desktop app uses `notifyDesktop`, which stays quiet while its window is focused). A run
  that succeeded names the task and plays the completion sound; a failed or timed-out one carries the
  first line of its error and says when it paused the task; a catch-up start is announced; a run waiting on an extension dialog (`run_attention`) asks the user
  to open its session; a run the
  user stopped by hand (`STOPPED_BY_USER`), skipped slots and ordinary starts are not. `SessionSidebar`'s
  generic "Finished" notification skips scheduled sessions (by relation, or by `isScheduledRunSession()`
  when the list has not caught up yet), or every run would notify twice. A scheduled session the user
  has open still gets the generic notification when its run ends, in addition to this one.

## Pitfalls
- Never compare errors from the scheduler with `instanceof` in a route; see the ADR.
- Tests that start runs must finish every session they hold open (`session.finish()`): a run
  keeps a time-limit timer, and a leftover one keeps the test process alive.
- `next dev` appends an agent-rules block to the repository's `AGENTS.md`; do not commit it.
- To try the whole thing without touching real data or a real model, point `PI_CODING_AGENT_DIR`
  at a scratch directory whose `models.json` names a local OpenAI-compatible endpoint.
