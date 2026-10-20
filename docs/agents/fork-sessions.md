# Sessions, events and the chat client — fork notes

## Editable composer outbox

`lib/composer-queue.ts` owns individually identified pending composer messages, including images.
`queue_composer` accepts into this outbox, `take_composer_message` claims one for edit/delete,
and `send_composer_message` claims one and submits it through the existing prompt admission
with `streamingBehavior: "steer"`. Already claimed IDs return a successful no-op with the latest
queue snapshot, without sending/restoring the message again. Every queue mutation increments
`pendingVersion`; clients ignore older polling, SSE or action snapshots so delayed responses
cannot resurrect consumed rows. Lock row actions immediately with a ref, before React renders.
Never clear/rebuild SDK
queues to emulate individual operations. SDK queues remain available to extensions.

After `agent_settled` and prompt-promise cleanup, the outbox checks `isRunning()` and admits
one next message through the existing MCP/preflight path. Rejection restores that entry and
pauses automatic delivery. Stop also pauses delivery, preserving entries for edit/delete or
explicit Send now; it must not stop one run only to start the next queued task immediately.
`composer_queue_update` and `get_state.queuedMessages.pending` keep views synchronized.
The process-global outbox survives page reloads and idle wrapper eviction, but not application
exit. Outbox data must not enter model context before delivery. Queue tests include real wrapper
admission and mocked run lifecycles; they do not call paid models or use user sessions.

Fork-owned notes moved out of `AGENTS.md` to keep it short. The upstream doc on the same topic (`docs/agents/*.md` without the `fork-` prefix) may describe the same area in other words; where they disagree, these notes describe this fork. Hard rules that must survive a merge are also listed in `AGENTS.md` under **Hard rules**.

## Branch summaries (pi's "Summarize branch?")
pi can summarize the branch being left onto the one entered (`navigateTree(id, { summarize, customInstructions })`, a `branch_summary` entry that becomes the new leaf). In BranchNavigator a plain row click stays a plain switch — rows are also how branches are browsed, and a dialog on every click would be in the way — while rows of other branches offer "Summarize & switch" (hover; always shown on touch) with an optional focus line. That switch is server-first (`summarizeAndNavigate` in `useAgentSession`): the transcript to show only exists once pi has written the summary, so the view does not switch optimistically like a plain switch. It blocks like an LLM call, locks branch switching and the composer, and shows a progress strip in the composer whose Stop sends `abort_branch_summary` (pi answers `{ cancelled: true, aborted: true }` and the leaf stays put). `branch_summary` entries render as a summary card (`CompactionMessageView kind="branch_summary"`) and start a displayed turn; they used to be projected as a fake user bubble that offered Edit / Fork. `branchSummary.skipPrompt` has nothing to skip here, since the GUI never prompts.

## Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

## A new session has no file until pi flushes it
Pi delays the first flush of a new session until an assistant message exists, so a run that just started is invisible to the disk scan behind `/api/sessions`. The sidebar list is derived purely from `.jsonl` files, so without help the session the user is actively watching cannot be found in the list until the turn ends.
- `/api/sessions` merges live runtime rows via `getRpcSessionInfos()` (`lib/rpc-manager.ts`) with `mergeSessionLists()` (`lib/session-reader.ts`); the disk row wins for a persisted id, and a runtime row is suppressed until a user message exists (otherwise an untouched "new chat" runtime renders a row that later vanishes). `ensure_session`-created idle runtimes are also suppressed. Once a prompt is submitted the wrapper's `pendingPromptPreview` (`getPendingPromptPreview()`) stands in for the missing user entry, so the row shows during MCP preparation and SDK preflight; `finishPrompt` clears it on completion, rejection and abort, and `notifyRunningChange()` dedupes on the running ids *and* `sessionListVersion` so every window refetches (see `docs/agents/sessions.md`).
- Sessions created by subagents carry a `relation: { kind: "subagent", ... }`; sidebar rows for subagents are hidden and their state aggregates into the parent row (`listSessionFamilies` in `lib/session-family.ts`).
- The disk scan behind the list is upstream's incremental scanner (`lib/session-list-scanner.ts`, `listSessionsIncremental`), fingerprinted per file on size+mtime in a persisted index (`globalThis.__piWebScanIndex`), so post-turn refreshes only re-parse the session that changed. `invalidateSessionListCache()` drops the merged list. Include symlinked project directories when touching the directory walk.
- `GET /api/sessions` returns a `sessionListVersion` counter; the sidebar's SSE handler refetches the list (reusing the invalidated server cache, no forced scan) whenever the version moves — that is how edits from another window/process appear.
- The sidebar refetches the list once per running id it has no row for, because a session can start running between list fetches.

## Event pipeline: SDK → wire → client (`lib/agent-event-stream.ts`, `lib/agent-event-wire.ts`)
- Per-agent SSE goes through `createAgentEventStream(req, id, sessionPromise)`: the session starts **asynchronously** (the route never `await`s `startRpcSession`), the stream filters events through `toClientAgentEvent()` and forwards them with one shared `TextEncoder`. Cancellation is `cancelStream(closeController)`; closing with `false` keeps the session's own listeners alive.
- The sidebar's running-id stream (`/api/agent/running/events`) keeps the older inline `dispose` pattern and must stay registered in `app/api/agent/events-route.test.mjs`.
- `subscribeRunningSessions()`/`notifyRunningChange()` in `rpc-manager.ts` broadcast the running-id set; `SessionSidebar` treats the stream as authoritative for running state (`sseAuthoritativeRef`) once connected, and a `sessionListVersion` bump on any SSE frame triggers a cache-reusing list refetch.

## Session listing: incremental scanner vs upstream catalogue
- `lib/session-list-scanner.ts` is the live scanner behind `SessionManager.listAll()`'s replacement: per-file info minus `allMessagesText`, re-parsed only when a file's size/mtime fingerprint changes; `invalidateSessionListCache()` drops the merged list cache. `lib/session-scan.ts` (with its `__piSessionScanCache` and `invalidateScannedSession`) is the fork's older scanner, kept only as a tested utility — nothing in the app reads its cache, so invalidating it does not refresh the sidebar.
- `resolveSessionPath()` tries a targeted header read (bounded to 4 KiB) before falling back to a full scan; `readSessionHeader()` never parses the whole file.
- Never reintroduce a literal `homedir()` into an fs call in these paths — route it through `userHome()` or the scanner walks the whole user profile at build time and Windows releases fail.

## Client session hook: guards you must keep when merging upstream (`hooks/useAgentSession.ts`)
- **Monotonic request ids**: `contextLoadIdRef`/`toolsLoadIdRef`/`sessionGenerationRef` — checking only the session id is not enough when the user switches A→B→A before a request settles. `loadContext`/`loadTools`/the `agent_end` refresh all capture and re-verify identity.
- **Session-load deadline**: `loadSession` fetches through `fetchWithRetry` (one retry with a longer deadline); a hung first attempt must not leave "loading session" forever.
- **Streaming seed**: `seedStreamingSnapshot()` re-hydrates the streaming bubble from `get_state.streamingMessage` on reconnect paths (page refresh mid-run).
- **Render-phase scroll save**: the departing session's scroll position is saved inside the `sessionIdentity !== appliedIdentity` render block, not in an effect cleanup — the browser clamps scrollTop to 0 before cleanup runs. `pendingInitialScrollTopRef` is consumed by the first-messages layout effect; upstream's `pendingScrollRestore` visibility gate hides the container until an in-page viewport restore lands.

## ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

## SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

## Compaction & summarization-retry SSE events
pi 0.86 emits `compaction_start`/`compaction_end` (the legacy `auto_compaction_*` names are gone — do not re-add their cases) plus `summarization_retry_scheduled/attempt_start/finished` when summary generation enters backoff. `handleAgentEvent` keeps `isCompacting` in sync and mirrors the retry counter into `summarizationRetry`, shown as "Compacting… (retry n/m)" on the compact control. `compaction_end.willRetry` deliberately leaves the counter in place so the countdown stays visible between compaction passes. Manual compact is a blocking POST — the button stays disabled until the response returns. Starting one lives in the composer's session (gear) menu, offered while `canCompactNow` (`onCompact && !isStreaming && !isCompacting`); a running compaction gets its own row control guarded only by `onCompact && isCompacting`, because an auto-compaction mid-run must stay visible and abortable, which is exactly when `isStreaming && isCompacting`.

## 0.86 event surface — the wire forwards everything, the client switch must keep up
`agent-event-wire.ts` whitelists by omission (only `turn_start/turn_end` dropped), so any new SDK event reaches the browser and is silently ignored unless `handleAgentEvent` has a case. Currently handled beyond the message lifecycle: `bash_execution_update` (live `!command` output, tail-capped by `PENDING_BASH_OUTPUT_CAP`), `thinking_level_changed` (immediate selector sync), `session_info_changed` (server invalidates the list cache), `entry_appended` (throttled idle-only transcript refresh — the SDK fires it for extension custom entries and cache warming, never for normal streaming). `executeBash` must `ensureEventsConnected(sid)` *before* dispatching the bash command, or the chunks have no stream to arrive on.

## `isRunning()` must consult the SDK's `isIdle`
pi ≥ 0.86 `isIdle` stays false through auto-retry backoff, branch summaries, and queued continuations — states where `isStreaming/isCompacting/isBashRunning` are all false between events. `AgentSessionWrapper.isRunning()` therefore ORs `inner.isIdle === false` into the flag check; dropping it re-introduces mid-retry wrapper eviction (`evictIfDiskAhead`) and premature idle shutdown. `IDLE_RESET_EVENT_TYPES` includes the retry-backoff events for the same reason.

## Running-state and cross-window propagation
`notifyRunningChange()` fires on `agent_start` as well as `agent_end` (idle → running was never pushed, so other windows' sidebars missed starts), and every `/api/agent/running/events` frame carries `sessionListVersion` — the sidebar refetches the list when the version moves. `session_info_changed` (renames from any window/extension) invalidates the list cache *and* broadcasts a running frame, because that frame is the version's only delivery channel; the running set itself is unchanged.

## Session automation surface (0.86)
`get_state` reports `autoCompactionEnabled`, `autoRetryEnabled`, `steeringMode`, `followUpMode`; the composer's gear popover toggles them through `set_auto_compaction` / `set_auto_retry` / `set_steering_mode` / `set_follow_up_mode`, and `abort_retry` backs the "Cancel retry" link in the retry banner. `useAgentSession.automation` mirrors the four values inside `syncLiveModel` — every get_state path updates them automatically; a new session shows no gear until a wrapper exists (values null). Thinking levels come from `getSupportedThinkingLevels` per model; do not reintroduce a manual DeepSeek xhigh clamp — 0.86 `setThinkingLevel` clamps to `getAvailableThinkingLevels()` itself and a manual `state.thinkingLevel` write bypasses the append/emit path.

## Composer send path is single-shot and guarded
The prompt-anchor spacer must subtract the floating composer's separate trailing spacer (`composerOverlaySpacerRef`). Both contribute to the same scroll height; counting the composer clearance twice makes the first streaming tail-follow scroll push the sent message above the viewport.

`ChatInput.handleSend` routes slash commands through `runBuiltinCommand` (the pending-guard wrapper) and sends exactly one `onSend` with the `#session`-mention-resolved text. A merge once left a second raw `onSend(msg, …)` behind it: the first send flips `agentRunningRef`, the second hits the running guard and *restores the just-sent text back into the composer* — every message appeared to "stick". `components/ChatInput.test.mjs` runs the extracted handler in a VM to pin one-send semantics.

## `!command` output renders live, then collapses
The pending bash bubble accumulates `bash_execution_update` deltas into `pendingBash.output` and renders them through `BashExecutionView` as a synthesized partial result, default-expanded while running (`ToolCallBlock defaultExpanded`). When the run finishes the persisted message mounts collapsed like any other tool call — live-watched, then folded, is intentional.

## Stats count standalone usage entries
pi 0.86 cache warming appends `type:"usage"` entries (`kind: "cache_warm"`); `lib/session-stats.ts` folds them in exactly like the SDK's `getSessionStats()`. Skipping them under-reported tokens/cost against the TUI.

## Transcript system messages, usage entries and context edits (pi >= 0.86)
- Every new session's first request persists a `message` entry with `role: "system"` holding the prompt sections and tool declarations; later prompt or tool changes append more. The agent loop announces them with `message_start` / `message_end` like any message. They are provider input, never conversation: `toClientAgentEvent()` drops them before the SSE stream (they carry every tool schema), `handleAgentEvent` skips any that slip through, `entryToUiMessage()` returns null for them, and `BranchNavigator` / `lib/project-tree.ts` never label or preview a branch with one. They still count toward `messageCount` and `totalMessages`, exactly as the SDK counts them.
- `usage` entries (`kind: "cache_warm"`) record prompt-cache warming that is billed but never enters model context. `computeSessionStats()` adds them like compaction usage so the token/cost counters match `/session` in the TUI.
- `context_edit` entries omit or replace an earlier entry's model context without changing raw history; the UI ignores them. A retain-none compaction stores its own id in `firstKeptEntryId`.
- `SessionManager.listAll()` now reads files newest-mtime first (then reverse filename) so `--resume` can render progressively; its stable sort keeps that order for sessions with equal activity time, and `listSessionsIncremental()` reproduces it from the stat fingerprints it already keeps.

## Running state polling + reconciliation
- The sidebar does not poll running state: it subscribes to `/api/agent/running/events` (SSE) and reconnects on `visibilitychange`/`online` and after the stream closes. The session-list response is only the initial fallback until the first SSE frame arrives (`sseAuthoritativeRef`).
- `invalidateSessionListCache()` bumps the generation but **keeps** the previous scan, and the cache is fresh only while its recorded generation matches. Ordinary agent activity invalidates it constantly, and rebuilding costs hundreds of milliseconds because `loadAllSessions()` re-reads every forked and subagent session. Callers that only need metadata — mapping search hits to sidebar rows — pass `listAllSessions({ allowStale: true })` to read the previous scan and let the rebuild happen in the background. A stale scan is a complete catalogue apart from sessions created seconds ago, so those callers accept a brief window where a brand-new session is not yet listed.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.
- Every SSE (re)connection in `useAgentSession` is gated on `sessionHookMountedRef`. React Strict Mode (on by default in `next dev`) re-runs effects in declaration order after a simulated unmount: the mount-only effect's cleanup sets that ref to `false`, and it is only restored when that effect re-runs, *after* the warm-session effect. The warm-session effect therefore re-asserts the ref before `maintainEventsConnected()`. Without it a dev-server tab never opened the event stream on mount or when switching back to a running session, so streamed output and new messages stayed invisible until the 15-second reconcile poll or a page refresh (`next start` was unaffected).

## Per-session scroll restore must be saved before the render-phase reset
Switching sessions resets chat state *during render* (`sessionIdentity !== appliedIdentity` in `useAgentSession`), so the message list is emptied in the same commit — the browser clamps the container's `scrollTop` to 0 before any effect cleanup runs. Saving the position from an effect cleanup therefore records 0 for every switch (which restores as "top of the chat"). The save lives inside the render-phase reset block; an unmount-only cleanup covers ChatWindow remounts (there the DOM is still intact when cleanup runs). Positions and the lazy-load `visibleCount` are cached per session in module-level LRUs (`lib/scroll-memory.ts`): `scrollTop` is a pixel offset into the render window that existed at save time, so `visibleCount` must be restored with it or the offset lands on the wrong message. A viewport at the bottom is deliberately not saved — the restore path then falls back to scroll-to-bottom so users following the tail keep following it.

## The session load must have a deadline
Switching chats does **not** remount `ChatWindow` — `AppShell.handleSelectSession` deliberately keeps `sessionKey` stable so the input dock does not flash. That makes the single `GET /api/sessions/[id]` in `loadSession()` the only thing that ever clears `loading`, and the retry button only appears once the load *fails*. A bare `fetch` there is a hang away from leaving "loading session" on screen permanently, which is exactly what desktop users hit on the first switches after a cold start. It goes through `fetchWithRetry()` (`lib/fetch-timeout.ts`): a hung first attempt is abandoned, then retried once with a longer deadline — the server finishes its cold-start work regardless of the client giving up, so the retry usually lands warm.

## Extension command session actions (`ctx.newSession` / `ctx.fork` / `ctx.switchSession`)
The pi CLI's `AgentSessionRuntime` replaces its single session in place; Pi Web hosts many, so `createExtensionCommandContextActions()` in `lib/rpc-manager.ts` gives the target its own wrapper instead: `newSession` starts one through `startRpcSession()` (with `parentSession`, the source's model/thinking/tool selection, then `setup()` + `refreshContext()`), `fork` writes the file through the same `writeForkedSession()` the browser's Fork uses, and `switchSession` resolves the file's id. The source wrapper is not torn down — it finishes the command that asked for the move — and emits `session_replaced { sessionId }`, which `useAgentSession` follows through `onSessionForked`. `session_before_switch` / `session_before_fork` handlers still cancel, and `withSession` receives the target's `createReplacedSessionContext()`. These used to be stubs returning `{ cancelled: true }`, so commands built on them silently did nothing; `lib/rpc-manager-extension-session-actions.test.mjs` pins the behaviour.

## Exported session HTML
- `/api/sessions/[id]/export` delegates to pi's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.
