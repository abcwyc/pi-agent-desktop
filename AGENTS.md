# Pi Web - Development Notes

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit` · Lint: `npm run lint`

**Never run `next build` during dev**: it pollutes `.next/` and breaks `npm run dev`.

---

## Local environment traps

- **Building (or starting a fresh `next dev`) from inside the Pi desktop app's shell
  fails.** The app exports `NODE_ENV=production`, `__NEXT_PRIVATE_ORIGIN` and
  `__NEXT_PRIVATE_STANDALONE_CONFIG` (its own serialized Next config, from which function
  values are gone). Next's CLI prefers that serialized config over `next.config.ts`, so
  `next build` dies with `TypeError: generate is not a function` and a fresh `next dev`
  with `Missing field turbopackMemoryEviction` — while a dev server that was already
  running keeps working, which makes it look like a repo bug. `scripts/prepare-desktop.mjs`
  deletes both `__NEXT_PRIVATE_*` vars for this exact reason; do the same (or run from a
  normal terminal) before any `next build` / `npm run test:e2e`.
- The `node` on `PATH` may not be the one the project runs on: the Pi app bundles its own
  runtime, while a dev server started from a terminal uses another install. Check with
  `ps -o command= -p $(lsof -nP -iTCP:30141 -sTCP:LISTEN -t)`.
- `npm run test:e2e` refuses to start while a dev server holds `.next/dev/lock`, and
  `E2E_SERVER_MODE=start` (the mode CI uses) needs a production build. Both can be
  satisfied without touching the dev state by building into the isolated desktop dir and
  pointing the harness at it:
  `PI_WEB_DESKTOP_BUILD=1 node_modules/next/dist/bin/next build --webpack` then
  `E2E_SERVER_MODE=start PI_WEB_DESKTOP_BUILD=1 node e2e/run.mjs` (`next.config.ts` swaps
  `distDir` to `.next-desktop`, which is gitignored).

---

## Architecture

- **Browsing** (read-only, no AgentSession): `GET /api/sessions` lists `~/.pi/agent/sessions/`; `GET /api/sessions/[id]` reads the `.jsonl` through SDK `SessionManager` helpers and `lib/session-reader.ts`, or an open wrapper's in-memory `SessionManager`. `GET /api/agent/running` snapshots the running ids.
- **Sending**: `POST /api/agent/[id]` → `startRpcSession()` (`lib/rpc-manager.ts`) creates the AgentSession in-process (`createAgentSessionFromServices()`); `session.send(cmd)` → `session.prompt()`.
- **Events**: `GET /api/agent/[id]/events` streams SSE `data: {...}` from `session.onEvent()`, fed by `session.subscribe()`.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/route.ts          GET currently-running session ids
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
  auth/all-providers/route.ts     GET API-key provider list
  auth/api-key/[provider]/route.ts GET/POST/DELETE provider API key status/storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth provider list
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/pi-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models/enabled/route.ts         GET/PUT enabledModels switches for the Models panel
  models/refresh/route.ts         POST fetch provider catalogs from pi.dev on demand
  models/nonchat/route.ts         GET classifier + image models (with sign-in state) and the global Code mode choice
  models-config/route.ts          GET/PUT — read/write ~/.pi/agent/models.json
  models-config/catalog/route.ts  GET models.dev pricing presets
  models-config/discover/route.ts POST fetch a configured provider's upstream model list
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST package plugin management
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  worktrees/route.ts              GET list / POST create / PUT switch branch / DELETE git worktrees
  worktrees/fetch/route.ts        POST git fetch --prune + fresh branch lists
  desktop/read-images/route.ts    POST read natively-picked images into attachment payloads
  desktop/save/route.ts           POST copy a file to, or write bytes at, a natively-picked path

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  app-prefs.ts         APP_PREF_KEYS + typed localStorage accessors (SSR/private-mode safe)
  desktop-connection.ts useDesktopConnection() — local server health probe for the reconnect banner
  desktop-native.ts    native dialogs, open/reveal path, external links, save/import, window lifecycle
  desktop-notify.ts    native completion notifications (skipped while the window is focused)
  draft-store.ts       local draft persistence helpers
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  enabled-models.ts    pure minimal-edit engine for the `enabledModels` pattern list
  enabled-models-runtime.ts  SDK adapter: per-pattern resolution, provider kinds, settings IO
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for pi SDK objects
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  session-reader.ts   SessionManager wrappers + path cache + buildSessionContext adapter
  tool-presets.ts     PRESET_NONE/DEFAULT/FULL + getPresetFromTools()
  types.ts            shared TypeScript types
  normalize.ts        normalizeToolCalls() — field name mismatch between file format and our types
  workspace-state.ts  persisted session/cwd/file-tab restore for desktop cold starts
  worktree.ts         project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx in-session branch switcher
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  EnabledModelsSection.tsx  model switches inside ModelsConfig, backed by enabledModels
  AgentsConfig.tsx    built-in subagent toggle + agent profile editor
  PluginsConfig.tsx   modal for installed package plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  SettingsPanel.tsx   settings dialog; its General tab hosts the app intro, Version & Updates and the desktop-only switches
  AppUpdatesSection.tsx  Version & Updates block at the top of General
  desktop/DesktopAppSection.tsx  window/tray prefs; renders nothing outside Tauri
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)

hooks/
  useAgentSession.ts       messages, streaming, SSE, fork/navigate, reconciliation; built-in slash commands (/session, bare /mcp)
  useAudio.ts              completion sound + AudioContext unlock
  useDragDrop.ts           shared drag/drop state
  useIsMobile.ts           responsive breakpoint
  useKeyboardShortcuts.ts  Esc stops the running agent unless a field or nearer handler took it; Ctrl+Alt+N
  useTheme.ts              theme state
```

---

## Topic Notes

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)

- [sessions.md](docs/agents/sessions.md): AgentSession lifecycle and shutdown, fork vs in-session branching, session file rewrites, toolCall normalization, SSE reconnect and tool events, transcript system / usage / context-edit entries, running-state polling, exported HTML. Files: `lib/rpc-manager.ts`, `lib/session-reader.ts`, `lib/normalize.ts`, `hooks/useAgentSession.ts`, `app/api/agent/**`, `app/api/sessions/**`, `components/BranchNavigator.tsx`, `components/MessageView.tsx`, `components/CodemodeToolView.tsx`.
- [tools.md](docs/agents/tools.md): tool presets and Chat only, exact system prompts, tool exposure, the codemode / tool-search / mcp built-ins, the read-only MCP policy, the Code mode and PowerShell `defaultTools` switches. Files: `lib/tool-presets.ts`, `lib/tool-preset-preference.ts`, `lib/chat-only.ts`, `lib/exact-system-prompt.ts`, `lib/builtin-extensions.ts`, `lib/mcp-read-only-policy.ts`, `lib/codemode-settings.ts`, `lib/powershell-settings.ts`, `lib/global-settings-file.ts`, `app/api/agent/new/route.ts`, `app/api/tools/settings/route.ts`, tool selection in `lib/rpc-manager.ts`.
- [mcp-runtime.md](docs/agents/mcp-runtime.md): the per-session MCP host (when servers register and connect, reported states, trust read on every sync, idle release); `/mcp` in the composer. Files: `lib/mcp-host.ts`, `lib/mcp-transport.ts`, `lib/mcp-status.ts`, `lib/mcp-command.ts`, `lib/mcp-config-key.ts`, MCP wiring in `lib/rpc-manager.ts` and `lib/builtin-extensions.ts`, `/mcp` handling in `hooks/useAgentSession.ts`.
- [mcp-settings.md](docs/agents/mcp-settings.md): Settings › MCP reads without running anything, masking, the trust dialog's server list, row states, notices, Code mode choice, trust from Settings, Escape stacking, every `mcp.json` write and undo. Files: `app/api/mcp/route.ts`, `app/api/project-trust/route.ts`, `lib/mcp-config-read.ts`, `lib/mcp-config-file.ts`, `lib/mcp-undo.ts`, `lib/mcp-secrets.ts`, `lib/mcp-server-display.ts`, `lib/mcp-json-error.ts`, `lib/project-trust.ts`, `lib/regular-file.ts`, `lib/stacked-dialog.ts`, `lib/settings-navigation.ts`, `components/McpConfig.tsx`, `components/mcp-config-helpers.ts`, `components/ProjectTrustDialog.tsx`, `components/SettingsPanel.tsx`.
- [mcp-test-sign-in.md](docs/agents/mcp-test-sign-in.md): Settings › MCP Test (route checks, bounded connection, `!command` queue, redaction, status store) and OAuth sign-in / sign-out. Files: `app/api/mcp/test/**`, `app/api/mcp/sign-in/**`, `lib/mcp-test.ts`, `lib/mcp-entry-request.ts`, `lib/mcp-status.ts`, `lib/mcp-sign-in.ts`, `lib/mcp-sign-out.ts`, `components/McpSignIn.tsx`, `components/mcp-sign-in-helpers.ts`, `components/OAuthPastePanel.tsx`.
- [mcp-add.md](docs/agents/mcp-add.md): Settings › MCP add (paste re-parsed on the server, host-variable confirmation, literal secrets kept global, fresh-folder trust, the add pane) and the paste importer's escaping and grammars. Files: `lib/mcp-add.ts`, `lib/mcp-import*.ts`, `lib/shell-words.ts`, fresh-folder trust in `lib/project-trust.ts`, `components/McpAddServer.tsx`, `components/mcp-add-helpers.ts`, the `add` action of `app/api/mcp/route.ts`.
- [models.md](docs/agents/models.md): default model and reasoning level, mid-run reasoning changes, remote provider catalogs, `enabledModels` scoping and minimal edits, provider auth listing and credentials. Files: `app/api/models/**`, `app/api/models-config/**`, `app/api/auth/**`, `lib/default-preferences.ts`, `lib/model-scope.ts`, `lib/enabled-models*.ts`, `lib/model-catalog-refresh.ts`, `lib/provider-listing*.ts`, `components/ModelsConfig.tsx`, `components/EnabledModelsSection.tsx`, `components/ModelSelector.tsx`, `components/SelectorRow.tsx`.
- [files-and-access.md](docs/agents/files-and-access.md): worktrees and project grouping, the file access allow-list (the `/api/files` security boundary), file tree visibility, web password throttling. Files: `app/api/files/**`, `app/api/cwd/**`, `app/api/worktrees/**`, `app/api/file-index/**`, `app/api/web-auth/**`, `proxy.ts`, `lib/path-security.ts`, `lib/file-access.ts`, `lib/linked-directory.ts`, `lib/session-file-references*.ts`, `lib/file-tree-visibility.ts`, `lib/worktree.ts`, `lib/paths.ts`, `lib/auth-throttle.ts`, `components/FileExplorer.tsx`.
- [settings-ui.md](docs/agents/settings-ui.md): Plugins and Skills routes, sidebar group switches, the shared `SettingsUi` blocks every settings panel and add pane uses. Files: `app/api/plugins/**`, `app/api/skills/**`, `components/SettingsUi.tsx`, `components/settings-ui-helpers.ts`, `components/SkillsConfig.tsx`, `components/PluginsConfig.tsx`; also before adding a settings section or add pane.
- [subagents.md](docs/agents/subagents.md): the built-in subagent setting, profiles and their files, run status, completion notifications. Files: `lib/subagent*.ts`, `app/api/subagents/**`, `components/AgentsConfig.tsx`.
- [client-platform.md](docs/agents/client-platform.md): mobile software keyboard and viewport height, completion sound. Files: `hooks/useViewportHeight.ts`, `hooks/useAudio.ts`, the keyboard-open CSS.

---

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Branch summaries (pi's "Summarize branch?")
pi can summarize the branch being left onto the one entered (`navigateTree(id, { summarize, customInstructions })`, a `branch_summary` entry that becomes the new leaf). In BranchNavigator a plain row click stays a plain switch — rows are also how branches are browsed, and a dialog on every click would be in the way — while rows of other branches offer "Summarize & switch" (hover; always shown on touch) with an optional focus line. That switch is server-first (`summarizeAndNavigate` in `useAgentSession`): the transcript to show only exists once pi has written the summary, so the view does not switch optimistically like a plain switch. It blocks like an LLM call, locks branch switching and the composer, and shows a progress strip in the composer whose Stop sends `abort_branch_summary` (pi answers `{ cancelled: true, aborted: true }` and the leaf stays put). `branch_summary` entries render as a summary card (`CompactionMessageView kind="branch_summary"`) and start a displayed turn; they used to be projected as a fake user bubble that offered Edit / Fork. `branchSummary.skipPrompt` has nothing to skip here, since the GUI never prompts.

### Cost and routing visibility (virtual models, cost by model, cache warming)
pi 1.0's cost story is surfaced the way its TUI does. **Routed model:** under a virtual model (`registerVirtualModel`), `get_state.routedModel` carries the SDK's `routedModel` (the physical model of the latest response) and the composer shows `→ model • level` next to the selector, like pi's footer; `syncLiveModel` refreshes it on every state sync, and each run's end already refetches state. **Cost by model:** `lib/usage-breakdown.ts` ports pi's `getUsageCostBreakdown()` (not exported by the SDK — keep the port in step with `core/usage-totals.ts` on SDK bumps): assistant usage keyed by `provider/(responseModel ?? model)`, cache-warm `usage` entries by their model, tool results / compaction / branch summaries in one bucket. `computeSessionStats()` returns it as `costBreakdown`, `mergeSessionStats()` advances it with streamed messages, and the session panel lists it only when pi would (more than one row, or one row that is not the selected model). **Cache warming:** `get_state` / `get_session_stats` report `cacheWarming { mode, status }` (`settingsManager.getCacheWarmingMode()` + `cacheWarmingStatus`); `lib/cache-warming-display.ts` is a localized port of `formatCacheWarmingStatus()`, and the panel re-reads it through `GET /api/agent/[id]` each time it opens because warming advances on its own between runs (GET never starts a dormant session).

### Classifier and image models (Settings › Models)
pi ≥ 0.99 catalogs classifier (Jev) and image models (OpenRouter image models and others) beside chat models, but keeps them out of `/model`: a session reaches them only from codemode scripts (`models.classify()`, `models.generateImages()`), so codemode must be active — always with Code mode "Always on" (`+codemode`), otherwise only where an MCP server turned it on. `GET /api/models/nonchat` lists both types through `lib/nonchat-models.ts` (`getModelsOfType` for the catalog, `getAvailableOfType` for sign-in state; offline runtime) together with `readCodemodePreference()`. ModelsConfig has a `{ type: "nonchat" }` selection rendering `components/NonChatModelsDetail.tsx`, read-only, grouped by provider, whose Code mode notice links to Settings › MCP through `onOpenMcp` (SettingsPanel's `activateSection("mcp")`). pi never writes generated images to disk, so every tool-result image has a Save link (`downloadUrlAsFile`; native save dialog on desktop, browser download otherwise), named from the block's media type (`lib/result-image.ts`) because history serves large tool-result images from an API URL.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### A new session has no file until pi flushes it
Pi delays the first flush of a new session until an assistant message exists, so a run that just started is invisible to the disk scan behind `/api/sessions`. The sidebar list is derived purely from `.jsonl` files, so without help the session the user is actively watching cannot be found in the list until the turn ends.
- `/api/sessions` merges live runtime rows via `getRpcSessionInfos()` (`lib/rpc-manager.ts`) with `mergeSessionLists()` (`lib/session-reader.ts`); the disk row wins for a persisted id, and a runtime row is suppressed until a user message exists (otherwise an untouched "new chat" runtime renders a row that later vanishes). `ensure_session`-created idle runtimes are also suppressed.
- Sessions created by subagents carry a `relation: { kind: "subagent", ... }`; sidebar rows for subagents are hidden and their state aggregates into the parent row (`listSessionFamilies` in `lib/session-family.ts`).
- The disk scan behind the list is upstream's incremental scanner (`lib/session-list-scanner.ts`, `listSessionsIncremental`), fingerprinted per file on size+mtime in a persisted index (`globalThis.__piWebScanIndex`), so post-turn refreshes only re-parse the session that changed. `invalidateSessionListCache()` drops the merged list. Include symlinked project directories when touching the directory walk.
- `GET /api/sessions` returns a `sessionListVersion` counter; the sidebar's SSE handler refetches the list (reusing the invalidated server cache, no forced scan) whenever the version moves — that is how edits from another window/process appear.
- The sidebar refetches the list once per running id it has no row for, because a session can start running between list fetches.

### Event pipeline: SDK → wire → client (`lib/agent-event-stream.ts`, `lib/agent-event-wire.ts`)
- Per-agent SSE goes through `createAgentEventStream(req, id, sessionPromise)`: the session starts **asynchronously** (the route never `await`s `startRpcSession`), the stream filters events through `toClientAgentEvent()` and forwards them with one shared `TextEncoder`. Cancellation is `cancelStream(closeController)`; closing with `false` keeps the session's own listeners alive.
- The sidebar's running-id stream (`/api/agent/running/events`) keeps the older inline `dispose` pattern and must stay registered in `app/api/agent/events-route.test.mjs`.
- `subscribeRunningSessions()`/`notifyRunningChange()` in `rpc-manager.ts` broadcast the running-id set; `SessionSidebar` treats the stream as authoritative for running state (`sseAuthoritativeRef`) once connected, and a `sessionListVersion` bump on any SSE frame triggers a cache-reusing list refetch.

### Session listing: incremental scanner vs upstream catalogue
- `lib/session-list-scanner.ts` is the live scanner behind `SessionManager.listAll()`'s replacement: per-file info minus `allMessagesText`, re-parsed only when a file's size/mtime fingerprint changes; `invalidateSessionListCache()` drops the merged list cache. `lib/session-scan.ts` (with its `__piSessionScanCache` and `invalidateScannedSession`) is the fork's older scanner, kept only as a tested utility — nothing in the app reads its cache, so invalidating it does not refresh the sidebar.
- `resolveSessionPath()` tries a targeted header read (bounded to 4 KiB) before falling back to a full scan; `readSessionHeader()` never parses the whole file.
- Never reintroduce a literal `homedir()` into an fs call in these paths — route it through `userHome()` or the scanner walks the whole user profile at build time and Windows releases fail.

### Client session hook: guards you must keep when merging upstream (`hooks/useAgentSession.ts`)
- **Monotonic request ids**: `contextLoadIdRef`/`toolsLoadIdRef`/`sessionGenerationRef` — checking only the session id is not enough when the user switches A→B→A before a request settles. `loadContext`/`loadTools`/the `agent_end` refresh all capture and re-verify identity.
- **Session-load deadline**: `loadSession` fetches through `fetchWithRetry` (one retry with a longer deadline); a hung first attempt must not leave "loading session" forever.
- **Streaming seed**: `seedStreamingSnapshot()` re-hydrates the streaming bubble from `get_state.streamingMessage` on reconnect paths (page refresh mid-run).
- **Render-phase scroll save**: the departing session's scroll position is saved inside the `sessionIdentity !== appliedIdentity` render block, not in an effect cleanup — the browser clamps scrollTop to 0 before cleanup runs. `pendingInitialScrollTopRef` is consumed by the first-messages layout effect; upstream's `pendingScrollRestore` visibility gate hides the container until an in-page viewport restore lands.

### Thinking-level state model (post-0.9.1)
Four states, not one: `newSessionThinkingLevel` (composer pre-send), `newSessionDefaultThinkingLevel` (from `/api/models` pins + `defaultThinkingLevel`), `currentThinkingOverride` (explicit user choice), `liveThinkingLevel` (wrapper-reported). `thinkingLevel` returned to the UI is `displayThinkingLevel ?? "auto"`. "auto" clears all overrides and leaves pi's setting untouched. The selector prefers the live wrapper model/thinking over persisted response metadata.

### Security posture from the upstream main merge
- `PI_WEB_PASSWORD` (off by default) enables browser password login with `pi_web_session` cookie (SameSite=Lax) and global backoff throttling (`lib/auth-throttle.ts`). When disabled, loopback/desktop-token paths behave exactly as before — desktop token auth is independent.
- Manual-code OAuth handshake tokens are `crypto.randomUUID()`; never revert to Math.random.
- Inline SVG previews opened as documents get a CSP that blocks script execution (`HTML_PREVIEW_CSP` in the files route).
- Local HTML previews have two modes (`FileViewer` TextFileViewer). Default: the file is loaded from `/api/files/...?type=serve` in an iframe with `sandbox="allow-same-origin"` and no `allow-scripts`, so relative CSS/images/fonts resolve through the untyped-request fallback while `HTML_PREVIEW_CSP` and the sandbox block script. Opt-in "Run scripts" (shown only when the page has `<script>`): `srcDoc` with `sandbox="allow-scripts"` — an opaque origin, so its scripts cannot call the API, and local relative files do not load. Never give one iframe both `allow-scripts` and `allow-same-origin`; `app/api/files/stream-route.test.mjs` pins this, and that `getServeMime` keeps `SERVE_EXT_TO_MIME` (a merge once dropped it and HTML was served as `application/octet-stream`).

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` -> `toolNames[]`) and persisted in versioned `pi-web:tool-selection` custom entries. No entry means a legacy session and keeps Pi's default behavior; an empty array means Chat only. Chat only resolves before services are created, loads no extensions/skills/prompts/themes, and replaces Pi's base prompt with the ordered contents of Pi's discovered context files. Crossing the Chat-only boundary rebuilds the wrapper; changing between nonempty presets updates it in place. The composer preset chips stay a fork layer on top: for an existing session the active preset is inferred on mount via `get_tools` → `getPresetFromTools()` (see `lib/tool-presets.ts`), and the #700 guard keeps a pinned default from being rewritten by an unpinned read.

**Exact system prompts go through `before_agent_start`.** Since pi 0.86 the prompt lives in the transcript: `agent.state.systemPrompt` is a getter replayed from persisted system messages (assigning it throws), and the agent loop's request context has no `systemPrompt` field, so neither mutating the state nor patching `prepareNextTurnWithContext` reaches the model. Chat-only sessions and subagent profiles in replace mode register `lib/exact-system-prompt.ts` as an inline extension factory on the resource loader; its `before_agent_start` handler returns `{ systemPrompt }`, which the SDK projects as the provider's leading system prompt for the whole run while the transcript keeps recording Pi's structured sections. `get_state.systemPrompt` reports the exact prompt for those wrappers because the SDK state only shows the structured sections. Subagents persist their active tools plus profile-level skill and extension loading switches in `resourceSnapshot`; loaded extensions cannot expose the reserved `Agent`, `get_subagent_result`, or `steer_subagent` tools to a subagent. See `docs/adr/0002-chat-only-tool-selection.md`.

### pi ≥ 0.86: `state.systemPrompt` is read-only — project, never assign
`AgentState.systemPrompt` became a getter replayed from the transcript's system messages; assigning it throws at runtime (tsc only catches this in code typed against the real SDK — `rpc-manager.ts` goes through the structural `AgentSessionLike`, where it is invisible). Since the 2026-09-25 upstream merge the fork uses upstream's mechanism: `lib/exact-system-prompt.ts` registers a `before_agent_start` extension factory on the resource loader (see the tool-preset section above), and the fork's former `transformContext` projection (`AgentSessionWrapper.applyExactSystemPrompt()`) was deleted in its favor — do not re-add a second exact-prompt path. Stream functions take a `TranscriptContext` — fold a `Context` with `normalizeContext()` before calling one (see `lib/session-title.ts`). `lib/session-list-scanner.ts` reproduces the SDK's ordering (modified descending, then stat mtime, then reverse filename) with the same tie order upstream's `listSessionsIncremental()` implements; the summary/`detailsPending` hydration pass and the scanner's persisted index come from upstream's perf work.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions. A model picked in the browser is session-scoped, as in the TUI: it is applied atomically during `AgentSession` construction and never written to the global defaults (upstream #871 removed `lib/startup-preferences.ts`; saving a default is its own request, `PUT /api/models/default`, offered by the model selector's star and `defaultModel`/`savedDefaultThinkingLevel` props).

### Remote provider catalogs
pi's built-in model lists are generated when the SDK is built and pi-web pins one SDK version, so a model a provider ships after that release is invisible until pi-web publishes a new version (#914). The SDK carries the other half: each built-in provider is wrapped in a pi.dev catalog overlay that `ModelRuntime.refresh()` fetches and persists to `~/.pi/agent/models-store.json`, and restoring that overlay needs no network. Both of pi-web's refresh paths ask for the offline half only (`createAgentSessionServices()` and `lib/provider-usage.ts` pass `allowNetwork: false`), which is why running the pi CLI once used to be the fix — the CLI refreshed with the network on and pi-web read what it left behind.

`lib/model-catalog-refresh.ts` runs that network pass, and **only when the user asks for it**: the "Refresh catalog" button in `EnabledModelsSection` posts to `/api/models/refresh`. Nothing refreshes catalogs on a timer or on another request's path — a pass fetches a catalog per authenticated provider, and a save must not wait on a slow one, the same reason `/api/auth/api-key/[provider]` stores the credential itself instead of calling `ModelRuntime.login()`. `refresh()` is called with `force: true`, since pressing the button is exactly a request to skip the SDK's four-hour freshness window, but *without* `allowNetwork`, so the runtime keeps applying its own `PI_OFFLINE` rule instead of pi-web overriding it; the module reports `reason: "offline"` rather than pretending a pass ran. `shareModelCatalogRefresh()` joins concurrent presses for the same providers so two tabs cannot race over the store file.

Change detection compares the model ids and names the runtime exposes, never the stored bytes: a successful revalidation rewrites `checkedAt` and `etag` on every pass. It only decides whether `invalidateModelsCache()` runs and whether the panel reloads — the overlay itself reaches the UI through the ordinary `/api/models` and `/api/models/enabled` loads, which build a fresh runtime that restores the store, so the refresh route never returns a model list of its own.

### `enabledModels` scoping
The `enabledModels` setting uses pi's `--models` syntax: minimatch globs against `provider/modelId` or a bare `modelId`, fuzzy matching for non-glob patterns, and an optional `:thinkingLevel` suffix. Never compare those patterns as literal strings — `lib/model-scope.ts` delegates to the SDK's `resolveModelScopeWithDiagnostics()` so pi-web and the TUI agree on the visible model list, and falls back to all available models when patterns resolve to nothing. `startRpcSession()` resolves that scope before creating an AgentSession and passes the selected initial model, thinking pin, and SDK-native `scopedModels` atomically; `GET /api/models` reuses the helper only for selector data, `thinkingLevelPins`, and `modelScopeWarnings` display.

Editing that setting from the Models panel goes through `/api/models/enabled`, never through pattern strings composed in the browser. Each toggle is a **minimal edit** of the stored list (`lib/enabled-models.ts`): a pattern that matches no available model is preserved verbatim, only the pattern covering the switched-off model is expanded in place (keeping its `:level` suffix), and every provider that ends up fully enabled with two or more entries collapses back into one glob — pi refreshes provider catalogs from the network into `models-store.json`, so an enumerated list rots when a model is renamed (deepseek's `deepseek-v4-flash` became `deepseek-flash`), while a glob heals itself. A lone exact reference is a deliberate pick and is left alone. **Never assume `provider/*` covers a provider**: pi matches with minimatch, whose `*` stops at `/`, so that glob silently misses every nested model id (`commandcode/sakana/fugu-ultra`, most OpenRouter ids) — writing it turned "enable all" into 15 of 71 models. `resolveProviderGlobs()` resolves `provider/*` then `provider/**` and keeps one only when its match set is exactly the provider's models; a provider that neither covers is written model by model. Also never rewrite the whole list from `getAvailable()` the way the TUI's `/scoped-models` does — it only sees providers that currently pass `checkAuth()`, so that would delete every entry for a provider whose credential is missing right now, and flatten globs and pins.

Disabling the last enabled model is refused with `409 { reason: "last-model" }`: pi falls back to every model when a scope resolves to nothing, so an empty list silently means the opposite. Writes always target the global settings file; a project `.pi/settings.json` replaces the global array instead of merging, so the route reports `scope: "project"`, renders the switches read-only, and returns that file's path as `settingsPath` — the banner names the file it just wrote (`~/.pi/agent/settings.json · enabledModels 20/104`) instead of describing the effect in prose. Built-in *and* extension-registered providers get per-model switches; models.json providers are switched as a whole by `EnabledModelsProviderSwitch` in their detail header, next to Delete, because a custom model can simply be deleted and both bulk buttons only ever sent the same provider-wide write. That switch is on only when every model of the provider is on, so a partial selection reads as off beside the sidebar's `1/2` badge and one click completes it; reading it as "any enabled" would leave partial unreachable in both directions once the last-model guard blocks the way down. Why it cannot move is its tooltip, not body text. `op: "prune"` is the only operation that drops unmatched entries, for cleaning up after such a rename; everything else preserves them. Saving models.json re-reads the switches through `op: "resync"`, which repairs the stored patterns against the new catalog: it rewrites renamed **models** and then renamed **providers**, **cuts back entries whose provider prefix no longer scopes them**, and re-asserts the providers that were fully enabled before the save. (Model references first: they still spell the old provider id, which the provider rewrite would otherwise have replaced already.) All three are needed because a pattern's meaning depends on the catalog. pi matches a pattern against the bare `modelId` as well as `provider/modelId`, so `stepfun/*` also matches another provider's model whose id *is* `stepfun/Step-5-Preview` — renaming a provider to `stepfun` silently enabled three `commandcode` models, and switching stepfun off then wrote them into the file. In the other direction, renaming a model to an id with a slash drops it out of `provider/*` (minimatch `*` stops at `/`), so a fully enabled provider silently loses it. A model renamed in the panel is a known move, not the kind of mismatch worth preserving: leaving `stepfun/ddd` behind after it became `stepfun/ddd1` loses the selection, and when it was the only entry the scope resolves to nothing, which pi reads as "no scope" and quietly enables every model. `ModelsConfig` mirrors every array move of the draft in `savedModelIdsRef` so `collectModelRenames()` can tell a rename from an add or a delete without guessing. Only `resync` repairs entries; ordinary toggles stay minimal edits and never rewrite what the user did not touch. A models.json provider missing from the runtime (unsaved edits, no models, a key that does not work) must not be reported as a sign-in problem, which is why it has its own control: the switch renders disabled with that reason as its tooltip, while `EnabledModelsSection` — now built-in only — keeps the sign-in empty state. See `docs/adr/0004-enabled-models-toggles.md`.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction & summarization-retry SSE events
pi 0.86 emits `compaction_start`/`compaction_end` (the legacy `auto_compaction_*` names are gone — do not re-add their cases) plus `summarization_retry_scheduled/attempt_start/finished` when summary generation enters backoff. `handleAgentEvent` keeps `isCompacting` in sync and mirrors the retry counter into `summarizationRetry`, shown as "Compacting… (retry n/m)" on the compact control. `compaction_end.willRetry` deliberately leaves the counter in place so the countdown stays visible between compaction passes. Manual compact is a blocking POST — the button stays disabled until the response returns. The compact block renders whenever `onCompact && (!isStreaming || isCompacting)`: an auto-compaction mid-run must stay visible and abortable, which is exactly when `isStreaming && isCompacting`.

### 0.86 event surface — the wire forwards everything, the client switch must keep up
`agent-event-wire.ts` whitelists by omission (only `turn_start/turn_end` dropped), so any new SDK event reaches the browser and is silently ignored unless `handleAgentEvent` has a case. Currently handled beyond the message lifecycle: `bash_execution_update` (live `!command` output, tail-capped by `PENDING_BASH_OUTPUT_CAP`), `thinking_level_changed` (immediate selector sync), `session_info_changed` (server invalidates the list cache), `entry_appended` (throttled idle-only transcript refresh — the SDK fires it for extension custom entries and cache warming, never for normal streaming). `executeBash` must `ensureEventsConnected(sid)` *before* dispatching the bash command, or the chunks have no stream to arrive on.

### `isRunning()` must consult the SDK's `isIdle`
pi ≥ 0.86 `isIdle` stays false through auto-retry backoff, branch summaries, and queued continuations — states where `isStreaming/isCompacting/isBashRunning` are all false between events. `AgentSessionWrapper.isRunning()` therefore ORs `inner.isIdle === false` into the flag check; dropping it re-introduces mid-retry wrapper eviction (`evictIfDiskAhead`) and premature idle shutdown. `IDLE_RESET_EVENT_TYPES` includes the retry-backoff events for the same reason.

### Running-state and cross-window propagation
`notifyRunningChange()` fires on `agent_start` as well as `agent_end` (idle → running was never pushed, so other windows' sidebars missed starts), and every `/api/agent/running/events` frame carries `sessionListVersion` — the sidebar refetches the list when the version moves. `session_info_changed` (renames from any window/extension) invalidates the list cache *and* broadcasts a running frame, because that frame is the version's only delivery channel; the running set itself is unchanged.

### Session automation surface (0.86)
`get_state` reports `autoCompactionEnabled`, `autoRetryEnabled`, `steeringMode`, `followUpMode`; the composer's gear popover toggles them through `set_auto_compaction` / `set_auto_retry` / `set_steering_mode` / `set_follow_up_mode`, and `abort_retry` backs the "Cancel retry" link in the retry banner. `useAgentSession.automation` mirrors the four values inside `syncLiveModel` — every get_state path updates them automatically; a new session shows no gear until a wrapper exists (values null). Thinking levels come from `getSupportedThinkingLevels` per model; do not reintroduce a manual DeepSeek xhigh clamp — 0.86 `setThinkingLevel` clamps to `getAvailableThinkingLevels()` itself and a manual `state.thinkingLevel` write bypasses the append/emit path.

### Composer send path is single-shot and guarded
`ChatInput.handleSend` routes slash commands through `runBuiltinCommand` (the pending-guard wrapper) and sends exactly one `onSend` with the `#session`-mention-resolved text. A merge once left a second raw `onSend(msg, …)` behind it: the first send flips `agentRunningRef`, the second hits the running guard and *restores the just-sent text back into the composer* — every message appeared to "stick". `components/ChatInput.test.mjs` runs the extracted handler in a VM to pin one-send semantics.

### `!command` output renders live, then collapses
The pending bash bubble accumulates `bash_execution_update` deltas into `pendingBash.output` and renders them through `BashExecutionView` as a synthesized partial result, default-expanded while running (`ToolCallBlock defaultExpanded`). When the run finishes the persisted message mounts collapsed like any other tool call — live-watched, then folded, is intentional.

### Stats count standalone usage entries
pi 0.86 cache warming appends `type:"usage"` entries (`kind: "cache_warm"`); `lib/session-stats.ts` folds them in exactly like the SDK's `getSessionStats()`. Skipping them under-reported tokens/cost against the TUI.

### Touch affordances
Session rows render the "…" action menu when `(hovered || touchMode)` — `touchMode` is a post-mount `matchMedia("(hover: none)")` check, so hover styling is untouched on desktop and rename/delete stay reachable on touch. On narrow screens a compact Stop button renders *outside* the collapsed "More controls" row while a run is active. Rename/delete failures surface a fixed-position toast (`sidebar.renameFailed` / `sidebar.deleteFailed`) instead of being swallowed.

### Transcript system messages, usage entries and context edits (pi >= 0.86)
- Every new session's first request persists a `message` entry with `role: "system"` holding the prompt sections and tool declarations; later prompt or tool changes append more. The agent loop announces them with `message_start` / `message_end` like any message. They are provider input, never conversation: `toClientAgentEvent()` drops them before the SSE stream (they carry every tool schema), `handleAgentEvent` skips any that slip through, `entryToUiMessage()` returns null for them, and `BranchNavigator` / `lib/project-tree.ts` never label or preview a branch with one. They still count toward `messageCount` and `totalMessages`, exactly as the SDK counts them.
- `usage` entries (`kind: "cache_warm"`) record prompt-cache warming that is billed but never enters model context. `computeSessionStats()` adds them like compaction usage so the token/cost counters match `/session` in the TUI.
- `context_edit` entries omit or replace an earlier entry's model context without changing raw history; the UI ignores them. A retain-none compaction stores its own id in `firstKeptEntryId`.
- `SessionManager.listAll()` now reads files newest-mtime first (then reverse filename) so `--resume` can render progressively; its stable sort keeps that order for sessions with equal activity time, and `listSessionsIncremental()` reproduces it from the stat fingerprints it already keeps.

### Running state polling + reconciliation
- The sidebar does not poll running state: it subscribes to `/api/agent/running/events` (SSE) and reconnects on `visibilitychange`/`online` and after the stream closes. The session-list response is only the initial fallback until the first SSE frame arrives (`sseAuthoritativeRef`).
- `invalidateSessionListCache()` bumps the generation but **keeps** the previous scan, and the cache is fresh only while its recorded generation matches. Ordinary agent activity invalidates it constantly, and rebuilding costs hundreds of milliseconds because `loadAllSessions()` re-reads every forked and subagent session. Callers that only need metadata — mapping search hits to sidebar rows — pass `listAllSessions({ allowStale: true })` to read the previous scan and let the rebuild happen in the background. A stale scan is a complete catalogue apart from sessions created seconds ago, so those callers accept a brief window where a brand-new session is not yet listed.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.
- Every SSE (re)connection in `useAgentSession` is gated on `sessionHookMountedRef`. React Strict Mode (on by default in `next dev`) re-runs effects in declaration order after a simulated unmount: the mount-only effect's cleanup sets that ref to `false`, and it is only restored when that effect re-runs, *after* the warm-session effect. The warm-session effect therefore re-asserts the ref before `maintainEventsConnected()`. Without it a dev-server tab never opened the event stream on mount or when switching back to a running session, so streamed output and new messages stayed invisible until the 15-second reconcile poll or a page refresh (`next start` was unaffected).

### Per-session scroll restore must be saved before the render-phase reset
Switching sessions resets chat state *during render* (`sessionIdentity !== appliedIdentity` in `useAgentSession`), so the message list is emptied in the same commit — the browser clamps the container's `scrollTop` to 0 before any effect cleanup runs. Saving the position from an effect cleanup therefore records 0 for every switch (which restores as "top of the chat"). The save lives inside the render-phase reset block; an unmount-only cleanup covers ChatWindow remounts (there the DOM is still intact when cleanup runs). Positions and the lazy-load `visibleCount` are cached per session in module-level LRUs (`lib/scroll-memory.ts`): `scrollTop` is a pixel offset into the render window that existed at save time, so `visibleCount` must be restored with it or the offset lands on the wrong message. A viewport at the bottom is deliberately not saved — the restore path then falls back to scroll-to-bottom so users following the tail keep following it.

### The session load must have a deadline
Switching chats does **not** remount `ChatWindow` — `AppShell.handleSelectSession` deliberately keeps `sessionKey` stable so the input dock does not flash. That makes the single `GET /api/sessions/[id]` in `loadSession()` the only thing that ever clears `loading`, and the retry button only appears once the load *fails*. A bare `fetch` there is a hang away from leaving "loading session" on screen permanently, which is exactly what desktop users hit on the first switches after a cold start. It goes through `fetchWithRetry()` (`lib/fetch-timeout.ts`): a hung first attempt is abandoned, then retried once with a longer deadline — the server finishes its cold-start work regardless of the client giving up, so the retry usually lands warm.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.
- The switcher also switches the *current* checkout's branch in place: `PUT /api/worktrees { cwd, branch }` → `switchBranch()` (local branch, or `checkout -b --track` when the name exists on exactly one remote). Branch names are validated to not start with `-` — they are passed as git argv, never through a shell. `POST /api/worktrees/fetch` runs `git fetch --prune` (with `GIT_TERMINAL_PROMPT=0` so it fails fast instead of hanging on a credential prompt) and returns fresh local/remote-only branch lists.
- The sidebar worktree state is event-driven by nature (agent end, cwd switch) — branches checked out *outside* pi would go stale. `SessionSidebar` therefore polls `/api/worktrees` every 10 s while the tab is visible, on window focus, and when the dropdown opens; the `checkedWorktreeCwdsRef` guard keeps those background refetches silent.
- A branch already checked out in another worktree cannot be checked out again (git refuses); clicking it in the switcher jumps to that worktree instead.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/pi-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.

### Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

### Built-in subagents
- The global `builtInEnabled` switch is persisted in `~/.pi/agent/agents/settings.json` and defaults to `false` when the file or field is absent. Malformed settings fail closed; atomic updates preserve unknown fields.
- The inline built-in extension factory is always present so reloading an existing wrapper can apply setting changes, but it registers no tools while disabled. After changing the switch, the user must explicitly reload the current session.
- When enabled, only a recognized legacy `pi-subagents` extension that registers any reserved tool (`Agent`, `get_subagent_result`, or `steer_subagent`) is removed. Unrelated extensions remain loaded, and resolved conflict diagnostics are discarded.
- Runtime `Agent` dispatch checks the setting again so a stale tool call cannot start a subagent after the feature is switched off.
- See `docs/adr/0003-built-in-subagent-toggle.md` for the precedence and persistence rationale.
- Individual built-in profiles (`general-purpose`, `explore`, `plan`) are switched off by name in the same file's `disabledBuiltIns` array, never by copying them out to a `.md` file: a copy freezes the built-in prompt at the version it was copied from and is visible to the other runtimes reading those directories. `builtInProfiles()` stamps `enabled` onto the constants so the panel, the `Agent` tool description, and `resolveSubagentProfile` agree; each write is a minimal edit that preserves names it did not touch, including ones no built-in claims (a newer build's). Reading the list fails *open* — the feature switch beside it has already failed closed — while `PATCH /api/subagents/profiles` with `scope: "builtin"` performs the write and `PUT`/`DELETE` still refuse that scope. A same-name file replaces the built-in outright and is switched off through its own frontmatter. Only the switch is live for a built-in; the rest of the form stays read-only. See `docs/adr/0005-built-in-subagent-disable.md`.
- A background run's completion notification (`notifyParent`) is skipped when the parent already collected the same result with `get_subagent_result`: the tool marks a finished background run consumed and the notification takes that mark. The check cannot happen only when the completion promise resolves — the parent is usually still inside its `get_subagent_result` poll at that moment (500ms interval) and `deliverAs: "followUp"` would just queue the duplicate until that turn ends. So `notifyParent` holds the message while the parent `isRunning()` and re-checks the mark before sending; an idle parent is still notified immediately.
- Agent profile files (`~/.pi/agent/agents/*.md`, project `.pi/agents/*.md`) are shared with other runtimes, so a save round-trips the frontmatter keys this app does not own (`name`, `allowed_subagents`, `exclude_extensions`, `disallowed_tools`, …) and carries foreign `ext:` tool selectors through. Managed keys are exactly `description`, `display_name`, `tools`, `load_skills`, `load_extensions`, `enabled`, `inherit_context`, `run_in_background`, `model`, `thinking`, `max_turns`.
- A background run's completion reaches the parent through `sendCustomMessage`, and pi's `convertToLlm` replays every `custom` message to the model as a plain `user` turn. `subagentNotificationText()` therefore prefixes the report with `SUBAGENT_NOTIFICATION_PREFIX` so a compaction pass — whose prompt asks what *the user* wants — does not file the subagent's output under Goal / Constraints (#875). Foreground `Agent` and `get_subagent_result` results keep the bare `subagentFinalText()`: they are already `toolResult` messages and need no marker. Keep the prefix in code, not in a profile prompt, so the model cannot drop it.
- The `skills` / `extensions` spellings pi-subagents reads are seeded on first save and kept in step while they are booleans; a hand-authored whitelist such as `extensions: pi-advisor-flow` is never rewritten, and the two flags fall back to those aliases when `load_skills` / `load_extensions` are absent.

### Extension command session actions (`ctx.newSession` / `ctx.fork` / `ctx.switchSession`)
The pi CLI's `AgentSessionRuntime` replaces its single session in place; Pi Web hosts many, so `createExtensionCommandContextActions()` in `lib/rpc-manager.ts` gives the target its own wrapper instead: `newSession` starts one through `startRpcSession()` (with `parentSession`, the source's model/thinking/tool selection, then `setup()` + `refreshContext()`), `fork` writes the file through the same `writeForkedSession()` the browser's Fork uses, and `switchSession` resolves the file's id. The source wrapper is not torn down — it finishes the command that asked for the move — and emits `session_replaced { sessionId }`, which `useAgentSession` follows through `onSessionForked`. `session_before_switch` / `session_before_fork` handlers still cancel, and `withSession` receives the target's `createReplacedSessionContext()`. These used to be stubs returning `{ cancelled: true }`, so commands built on them silently did nothing; `lib/rpc-manager-extension-session-actions.test.mjs` pins the behaviour.

### Web password throttling
- `lib/auth-throttle.ts` is deliberately global, not per-IP: Next 16 route handlers have no socket address and `x-forwarded-for` is spoofable, while the server binds `127.0.0.1` for a single operator. Failures double the delay (1s → 60s cap) for everyone; a success or 5 idle minutes resets it. The reset window must stay longer than the max delay or waiting out one block restarts the burst.
- State lives on `globalThis` under `Symbol.for("pi-web:auth-throttle")` so it survives hot reload and is shared by every module instance. Tests reset it with `recordAuthSuccess()`.
- `POST /api/web-auth` and every `Authorization: Basic` header on `/api/*` share the counter; `proxy.ts` checks Basic before its `/api/web-auth` exemption, so `GET /api/web-auth` is not an unthrottled password oracle. A valid session cookie is checked first and is never blocked. While blocked, Basic gets `429` even with the right password (otherwise the answer leaks), and a Basic success does not reset the counter: Basic clients authenticate on every request, so a reset would restart an interleaved guesser at the base delay. The proxy and route handlers share the `globalThis` state under both `next dev` and `next start` (checked by failing one and observing `429` on the other).

### Auth and model config
- `ModelsConfig` combines models from `~/.pi/agent/models.json` with provider auth status from pi's `AuthStorage`/`ModelRegistry`.
- Provider listing is capability-driven, never id-driven: `lib/provider-listing.ts` decides membership from `auth.apiKey.login` / `auth.oauth` plus the stored credential type, so dual-auth providers (anthropic and github-copilot today — which providers declare both changes between SDK releases, so never assume it from an id) appear exactly once and never fall through both lists (#309). `lib/provider-listing-runtime.ts` adapts `ModelRuntime` to those pure helpers.
- auth.json holds **one** credential per provider and `ModelRuntime.logout()` deletes whichever it is. The delete routes therefore use `removeStoredCredentialIfType()` to compare and delete under the same file lock used by pi's auth storage. `ModelsConfig` also refreshes *both* provider lists after any auth change — refreshing one leaves a dual-auth provider rendered twice.
- OAuth/device-code/manual-code flows are streamed by `GET /api/auth/login/[provider]`; manual code responses POST back with a short-lived token stored in `globalThis.__piLoginCallbacks`.
- API-key routes store and remove keys through `AuthStorage`. Status endpoints must never return the raw key.
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Exported session HTML
- `/api/sessions/[id]/export` delegates to pi's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

### Desktop shell (Tauri)
- `lib/desktop-native.ts` is the only place the UI touches Tauri APIs; every entry point checks `isTauriDesktop()` and degrades to a web equivalent. Tauri commands are declared in `src-tauri/src/lib.rs`, their permissions in `src-tauri/permissions/desktop-shell.toml`, and both must be listed in `src-tauri/capabilities/desktop-dialog.json` or the call fails at runtime only.
- `/api/desktop/read-images`, `/api/desktop/save`, and `/api/files?...type=import` deliberately accept absolute paths selected by native dialogs, so the normal `lib/file-access.ts` source/destination allow-list cannot cover them (`save` still allow-lists its *source*). They require a loopback Host, normal request-security checks, and the per-process desktop token from `lib/desktop-api-auth.ts`. The Tauri shell passes the token to the packaged server and exposes it to the trusted WebView through the capability-scoped `get_desktop_api_token` command. Never fall back to a static token or User-Agent detection.
- `read-images` caps the file count at `MAX_ATTACHED_IMAGES` from `lib/image-attachments.ts`. Keep it derived from that constant; a separate literal silently 400s selections the composer considered valid.
- Open a local path with `explorer.exe` on Windows, never `cmd.exe /C start` — Rust's argument escaping does not apply to the cmd parser, so a legal path like `C:\src\R&D\x.txt` would split into commands.
- `lib/app-prefs.ts` owns every `localStorage` key. Theme is additionally mirrored into the app config dir via the `set_ui_theme` command, because the packaged server's port (and therefore the WebView origin, and therefore `localStorage`) can change between cold starts.
- `tauri build` refuses to bundle when a `tauri-plugin-*` crate and its `@tauri-apps/plugin-*` npm package sit on different major/minor releases (same for `tauri` ↔ `@tauri-apps/api`), and it only says so six minutes into each platform of a signed release. The npm half moves on its own: a sync that runs a plain `npm install` re-resolves the caret ranges in `package.json` and leaves `src-tauri/Cargo.lock` behind — that is how v0.4.7 failed on all three runners with plugin-updater 2.12.0 against crate 2.10.1. Fix it in the lock (`cargo update -p tauri-plugin-updater --precise 2.12.0`), never by pinning the npm range down; `scripts/release-workflows.test.mjs` pins the pairing.
- `lib/workspace-state.ts` restores the last session/cwd/file tabs on cold start. URL params always win over the persisted workspace.
- `useDesktopConnection` polls `/api/home` only in Tauri to drive the offline banner. Its cleanup must stop in-flight probes from rescheduling, otherwise an unmount leaves a timer nobody owns and it pings forever.

### Settings dialog: one tab per concern
- The settings dialog's tabs are exactly `general`, `models`, `skills`, `agents`, `plugins` (`SETTINGS_SECTION_VALUES`). The former `desktop` tab duplicated General's language and theme pickers, so it was removed: the product blurb and Version & Updates sit at the top of General, the custom-stylesheet and diff-display controls joined General's appearance/chat sections, and the desktop window/tray switches live in `components/desktop/DesktopAppSection.tsx`, which renders nothing in a browser (same self-hiding contract as `WindowControls`). `components/AppUpdatesSection.tsx` owns the update check and its chips.
- A signed desktop update installs and relaunches the app, so `AppUpdatesSection` reports `busy` up to `SettingsPanel`, which keeps backdrop clicks and Escape from dismissing the dialog mid-upgrade. That is the reason for the `onBusyChange` prop; don't drop it when refactoring the panel.
- `UpdateReminder` opens the panel at `general`, where the update status now lives. `components/fork-extractions.test.mjs` pins that the update/desktop code stays in those fork-owned files instead of being regrouped into `SettingsPanel.tsx`.

### Workspace terminals & node-pty staging
- Terminal tabs load `node-pty` through a runtime-computed path (`prebuilds/${platform}-${arch}/*.node`), which Next's file tracer cannot follow — a bare standalone build ships only `lib/` and breaks at runtime. `prepare-desktop.mjs` copies the whole `prebuilds/` tree and chmods `spawn-helper` for **both** darwin variants (macOS strips the bit in published prebuilds; `bin/prepare-terminal.js` fixes the same thing at npm-install time). If terminal tabs 500 or hang in a packaged app, check that `resources/server/node_modules/node-pty/prebuilds/` exists with executable helpers first.
- Code mode's QuickJS sandbox loads `quickjs-wasi` through runtime `import.meta.resolve` (`quickjs.wasm` + `extensions/*.so`), which the file tracer also cannot follow — the traced output keeps only `dist/` and every packaged session loses Code mode with `Cannot find module .../quickjs-wasi/quickjs.wasm`. `prepare-desktop.mjs` calls `stageCompletePackage()` (`scripts/stage-package.mjs`) for it and for jiti: the complete source package overwrites **every staged copy**, wherever npm put it (pi 1.0.0 nested it under `pi-coding-agent`; pi 1.0.1 hoists it for `pi-codemode`), or lands at the top level when the tracer kept none. Never hard-code a nested destination: `dedupeNestedPackages()` deletes nested copies whose version matches the top level, which on 1.0.1 removed the complete copy and left the traced, incomplete top-level one. After any SDK bump run `npm run desktop:prepare && npm run desktop:verify`; it starts the staged server with the bundled Node, creates a session and reads the sandbox self-test, and fails on a missing wasm. It does not cover jiti.
- **Windows overwrite installs never delete old payload** (#72): Tauri's NSIS template only `File /a`s the new files over `$INSTDIR`, so a stale `resources/server/node_modules` survives an upgrade and Node's nearest-module resolution loads a leftover nested `@earendil-works/*` copy instead of the new top-level one — 0.4.7→0.5.1 shipped one and died on `does not provide an export named 'runToolCall'` with every API route 500ing. Three guards, all required: `NSIS_HOOK_PREINSTALL` in `src-tauri/installer-hooks.nsh` (registered via `bundle.windows.nsis.installerHooks` in `tauri.windows.conf.json`, resolved against src-tauri as cwd) clears `resources\server\node_modules` before the installer writes the fresh tree; `desktop/server-launcher.cjs` deletes any `@earendil-works/*/node_modules/@earendil-works/*` at startup, which heals installs that upgraded in place before the hook existed (the build never legitimately ships one — the whole scope is pinned to one version line — while nested non-pi deps like chalk/undici are normal and stay); and `prepare-desktop.mjs` fails the build if a nested pi-scope copy survives `dedupeNestedPackages()`. The dedupe pass depends on the pi-package overlay copying each `package.json` beside `dist/` — 0.4.7's top-level `pi-agent-core` had `dist/` only, `readPackageVersion()` returned null, the nested duplicate shipped, and that is how #72 happened.

### Upstream merge sentinels (not the same "fork" as session fork)
This repo is a fork of `agegr/pi-web` and periodically merges upstream. `components/fork-extractions.test.mjs` guards the failure mode that a clean merge can still be wrong: code this fork *moved* to another file reappears at its origin, or a fork change is silently reverted. Git does not track cross-file moves, so neither shows up in `tsc`, eslint, or the upstream suite.

When one of those assertions fails, the default is to restore the behaviour, not to delete the assertion. A failure saying a marker is "absent from the origin but also from the extraction targets — it looks deleted, not moved" means the feature is probably gone: that is exactly how the project-picker filter box was found missing after a restyle had left every project past the 7-row cap unreachable. Risk levels live in `scripts/fork-ownership.json`; the reasoning is in `docs/ownership-boundaries.md`.

The third direction is `forbiddenMarkers` on a `FORK_FEATURES` entry: a region the *fork* deleted that upstream still ships. A clean merge re-adds it silently, so the entry asserts those strings stay absent from the file (currently the new-session branding header in `components/ChatWindow.tsx`). A failure there means "put the removal back", never "drop the marker".

### Topbar, chat column, and right panel — who contains whom
Upstream segment D (0e36743) restructured `AppShell.tsx`'s main region in ways this fork's layout cannot survive; all three are pinned by `components/AppShell.right-panel-row.test.mjs`:

1. The "Center: chat" column must contain BOTH the topbar's chat content AND the chat wrapper. A merge variant closed the column right after the topbar, making the chat wrapper a second `flex: 1` row child — the viewport split 50/50 between an empty topbar-only column and the chat ("huge blank middle column, chat clipped at the right edge").
2. The right-panel toggle/backdrop/resizer/panel block must be inside the row, not after its close: as flex-**column** children of `.app-shell` the closed panel's content height still stole vertical space (`height: 432px` at `width: 0`), floating the composer.
3. Since 2026-09-24 the topbar sits inside a main column that follows the sidebar as a child of the outer row: `.app-shell` (column) → offline banner → outer row → [backdrop, sidebar (full height), sidebar handle, main column → [topbar, inner row → [center chat, panel block]]]. The sidebar runs the full window height (its header hosts the macOS traffic lights via `session-sidebar-header--mac-inset`), and the topbar starts at the center column but still reaches the window's right edge, keeping `WindowControls` top-right. There is deliberately no `paddingLeft: sidebarResizer.width` on the topbar anymore — that was the old full-width-topbar hack that left a blank strip above the sidebar; re-adding it on a merge regresses the layout. `app-topbar--mac-inset` (72px) is only for the sidebar-closed/mobile case where the traffic lights land on the topbar itself.

The topbar renders exactly ONE toolbar group (`app-topbar-actions`: history/branches/more), pushed to the right edge by `margin-left: auto` — right-aligned since 2026-09-24 (a user request; an earlier experiment had it left of the title via `order: -1`, removed). The inline session-stats button (`renderSessionStatsButton`, ↑in ↓out ↻cache $cost) was removed the same day — session info opens from the More menu entry instead; `sessionStats`/`contextUsage` state stays (auto-name guards + More-menu labels). Segment D also left a second desktop group (`renderChatToolbarActions(false)` — history/generate-title/system/tools) next to it; the duplicate is removed, its unique entries (Sub-agents, Tools) live in the More menu via `handleSystemInfoToggle` (keeping the lazy dormant-session start), and its generate-title guards (persisted-stats counting + `selectedSession.transient` check) were merged into the group-A button — pinned by `AppShell.auto-name.test.mjs`. JSX indentation in AppShell.tsx is unreliable; verify structure with the TS AST or the DOM, not by counting whitespace. `fileContentBlock()` in `AppShell.file-viewer-state.test.mjs` slices source by the panel's closing-div sequence — keep in sync.

### Upstream merge decisions (standing rules)
Full per-merge reasoning (segments E, F, G, with what was adopted and what was declined) is in [merge-history.md](docs/merge-history.md). The rules that still bind a future merge:
- **Upstream owns SDK adaptation.** Exact system prompts go through `lib/exact-system-prompt.ts` (`before_agent_start`); the session list comes from `lib/session-list-scanner.ts`; MCP and Code mode run on ADR 0006's `builtin:*` extensions (`createMcpExtension()` is never passed as a bare inline factory) and `resolveActiveToolNames()` replaced `withExtensionTools()`. Do not re-add a second path for any of these.
- **Declined upstream UI stays declined**: the sidebar explorer and resizable session/explorer panes (`data-resize-handle="sidebar-sections"`), `DirectoryPicker`, `SessionSearch`, `ChatMinimap`, `getSessionListIndices` windowing, the second mobile toolbar group, the topbar models/skills/settings quick-buttons, `ExtensionStatusBar` (the fork's `ExtensionStatusLine` replaces it). A merge that brings one back is re-introducing declined UI, not a test to satisfy.
- **Fork layers that must survive a merge**: `userHome()` routing instead of literal `homedir()`, models-config literal-key redaction, `resolveSessionReferences` in the send/queue paths, the monotonic request-id guards in `useAgentSession`, the project-tree sidebar with the full-height layout, desktop i18n and Settings sections.
- **`lib/startup-preferences.ts` stays deleted** (new-session model picks are session-scoped); `PUT /api/models/default` is the only writer of global defaults.
- **`package-lock.json` keeps the tauri plugin versions pinned to `src-tauri/Cargo.lock`**: restore HEAD's lock before `npm install --package-lock-only`, or the carets re-resolve and `release-workflows.test.mjs` fails.
- After a merge: `node scripts/upstream-css-baseline.mjs update <upstream-ref>` and `npm run drift`.

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`SessionContext.entryIds[]` parallels `messages[]`: each displayed message's `.jsonl` entry id, used for fork and navigate_tree.

## Styling: fork CSS lives only in `app/native-theme.css`

`app/globals.css` and `app/settings.css` are pi-web's and stay byte-identical to upstream — `scripts/upstream-css-baseline.test.mjs` fails on any edit. Put every fork rule in `app/native-theme.css` (imported last in `app/layout.tsx`); overrides of upstream rules that other theme rules must beat go in its "fork base layer" at the top. After an upstream merge run `node scripts/upstream-css-baseline.mjs update <upstream-ref>` (the sync workflow does). Layout of the theme file and the design intent to restore after a merge: `docs/native-theme.md`.

## CSS Variables (`app/globals.css`, re-tokened in `app/native-theme.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```
