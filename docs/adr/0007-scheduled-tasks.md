# Scheduled tasks: where they run, what they may do, how they are shown

Scheduled tasks start a fresh session at a chosen time and send a saved prompt.
They run in the local server process, not in the browser and not in the cloud.

**The scheduler lives in the server.** `instrumentation-node.ts` starts it at boot
(`PI_WEB_DISABLE_SCHEDULER=1` turns it off). The packaged app hides its window to the
tray on close and keeps the sidecar server alive, so tasks keep firing with no window
open. The scheduler and its event bus sit on `globalThis`: instrumentation and the route
handlers are bundled separately, so each has its own copy of every module and class. For
the same reason errors are matched by `name` (`isRunRejectedError()`), never `instanceof`.

**One process fires tasks.** A dev server and the desktop app both read `~/.pi/agent`.
`scheduler.lock` holds the owner's pid and a heartbeat; another process may take it over
when the heartbeat is older than 90 seconds or the pid is gone. Whoever runs a slot first
claims it by advancing the task's `lastScheduledFor` before the run starts, so two
processes that both believe they own the lease still cannot both run one slot.

**Runs are unattended, so the default is read-only.** pi has no approval layer: a run never
stalls waiting for permission, and it also never asks before acting. A task therefore pins
its tool preset into the session like any other session (`pi-web:tool-selection`), and the
default is `read-only`. `default` and `full` need `acknowledgeUnattendedWrites: true`, checked
by the server, not only by the form. The existing read-only MCP policy applies unchanged.

**Missed slots are caught up once.** After the app was closed or the machine asleep, the
newest missed slot within 7 days runs once as a `catch-up`; older ones are counted in
`skippedSlots` and dropped. A slot that arrives while the task is still running is
recorded as skipped (`overlap`). At most two scheduled runs start at once; the rest wait
for a later tick without losing their slot. Creating a task, changing its schedule and
resuming it all restart the catch-up window, so slots from before are not replayed.

**Runs are not in the project tree.** A run is an ordinary session file. The list marks it
`relation: { kind: "scheduled", taskId, runId }`, taken from an in-memory index over the run
files (`lib/scheduled-tasks/run-index.ts`), not from the transcript: the incremental
scanner reads a session's entries only when it has a parent, and reading every transcript
for this would slow every list. The sidebar leaves marked sessions out of the project tree
and the Scheduled page lists them under their task. The session also carries a
`pi-web:scheduled-run` entry, the durable record the index can be rebuilt from.

**Deleting a task returns its sessions to the project list.** The marker that hides a run is
the run file, so deleting a task deletes its run history too; the sessions it made carry no
marker afterwards and show up in the project tree like any other session. Keeping the history
would leave them hidden with no page that lists them, and a checkbox to choose between the two
only made the bad option reachable. Nothing a user wrote is deleted by deleting a task.

**One event stream per browser, not per tab.** A browser allows about six connections to one host
over HTTP/1.1 and a tab here already holds several long-lived ones, so a stream for every tab
would leave a few tabs unable to load anything. `lib/scheduled-tasks/shared-stream.ts` elects a
leader tab through the Web Locks API; only it opens the `EventSource` and it forwards events to the
others over a `BroadcastChannel`. A tab with neither API opens its own.

**Things a run cannot ask for are said up front, or reported.** A run has nobody to answer an
extension dialog, so it waits for the time limit; the session stays open and a `run_attention`
notification tells the user to open it. An untrusted folder starts runs without its project
extensions and MCP servers, so the editor says so beside the folder field. Errors the module
produces itself carry a code or an i18n key and parameters; the English text is only the fallback.

Rejected: Thread mode (every run in one conversation), because its context grows without
bound; event triggers and cloud execution, because this is a local-first app.
