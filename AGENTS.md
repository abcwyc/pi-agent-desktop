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
- A worktree's `node_modules` can lag the lockfile (created before an SDK bump), which
  fails tests that pin newer SDK behaviour. `npm test` runs `npm run check:deps` first and
  stops with the mismatched packages; `npm ci` fixes it.
- **`next dev` rewrites `AGENTS.md`**: it appends a "This is NOT the Next.js you know" block
  to this file on every start. Preserve the project and user instructions here; review generated
  additions separately and never reset the entire file to discard development output.

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
  scheduled-tasks/**              GET/POST tasks, PATCH/DELETE [id], POST [id]/run, GET [id]/runs, POST run seen, POST preview, GET events (SSE)
  worktrees/route.ts              GET list / POST create / PUT switch branch / DELETE git worktrees
  worktrees/fetch/route.ts        POST git fetch --prune + fresh branch lists
  desktop/read-images/route.ts    POST read natively-picked images into attachment payloads
  desktop/save/route.ts           POST copy a file to, or write bytes at, a natively-picked path
  artifacts/settings/route.ts     GET/PUT the "artifacts in the side panel" prompt switch

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  artifacts.ts         `:::artifact` scanner, markdown encoding, version collection
  artifact-store.ts    client store shared by ChatWindow, message cards and the artifact panel
  artifact-settings.ts / artifact-guide-extension.ts  prompt switch file + `<artifacts>` prompt section
  html-preview.ts      inline HTML/SVG/React preview detection, sandbox, srcdoc bootstrap, React document
  preview-runtime.ts   loads public/preview-runtime/ (bundled React, Sucrase, Tailwind) for React previews
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
  scheduled-tasks/    scheduler, runner, cron, store, run index for scheduled tasks (see docs/agents/scheduled-tasks.md)
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
  HtmlPreviewBlock.tsx / HtmlPreviewErrorBar.tsx  inline previews and their error strip
  ArtifactCard.tsx / ArtifactPanel.tsx / artifact-tabs.ts  artifact card in messages, right-panel tab
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  EnabledModelsSection.tsx  model switches inside ModelsConfig, backed by enabledModels
  AgentsConfig.tsx    built-in subagent toggle + agent profile editor
  PluginsConfig.tsx   modal for installed package plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  scheduled/          Scheduled page (list, detail, editor, run history) and its sidebar row
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
  useScheduledTasks.ts     shared store + SSE for scheduled tasks
  useKeyboardShortcuts.ts  Esc stops the running agent unless a field or nearer handler took it; Ctrl+Alt+N
  useTheme.ts              theme state
```

---

## Topic Notes

Read the doc for the area you touch before changing it. Upstream docs (no prefix) come from pi-web; `fork-*` docs hold this fork's notes and win where the two disagree.

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
- [scheduled-tasks.md](docs/agents/scheduled-tasks.md): scheduled tasks (the Scheduled page): server-side scheduler and its lease, catch-up and overlap rules, read-only default, the run index that hides runs from the project tree, why shared state is on `globalThis`. Files: `lib/scheduled-tasks/**`, `app/api/scheduled-tasks/**`, `instrumentation-node.ts`, `hooks/useScheduledTasks.ts`, `components/scheduled/**`, the Scheduled row in `components/SessionSidebar.tsx`, the page overlay in `components/AppShell.tsx`.
- [artifacts.md](docs/agents/artifacts.md): inline HTML/SVG/React previews and `:::artifact` blocks: what renders where, the sandbox rules and the desktop `about:srcdoc` allowance, the auto-run rule for scripted pages, the bundled React runtime (inlined, because sandboxed frames cannot reach localhost; `npm run preview-runtime` regenerates it), the fix flow and the prompt switch. Files: `lib/artifacts.ts`, `lib/artifact-store.ts`, `lib/html-preview.ts`, `lib/artifact-settings.ts`, `lib/artifact-guide-extension.ts`, `hooks/useArtifactPublisher.ts`, `hooks/useHtmlPreviewFrame.ts`, `lib/preview-runtime.ts`, `scripts/build-preview-runtime.mjs`, `public/preview-runtime/`, `components/Artifact*.tsx`, `components/HtmlPreview*.tsx`, `components/artifact-tabs.ts`, `app/api/artifacts/**`, `is_inline_frame_document` in `src-tauri/src/lib.rs`.
- [client-platform.md](docs/agents/client-platform.md): mobile software keyboard and viewport height, completion sound. Files: `hooks/useViewportHeight.ts`, `hooks/useAudio.ts`, the keyboard-open CSS.

Fork notes:
- [fork-sessions.md](docs/agents/fork-sessions.md): branch summaries, the not-yet-flushed new session, the SDK → wire → client event pipeline, the incremental session scanner, `useAgentSession` guards (request ids, load deadline, streaming seed, render-phase scroll save), compaction / retry / 0.86 events, `isRunning()` and `isIdle`, running-state propagation and reconciliation, session automation, the single-shot composer send, `!command` output, stats, transcript system messages, extension command session actions.
- [fork-models.md](docs/agents/fork-models.md): routed model, cost by model and cache warming, classifier and image models, the four thinking-level states, model defaults, remote provider catalogs (refresh only on request), `enabledModels` minimal edits and `resync`, auth and credential deletion.
- [fork-tools-subagents.md](docs/agents/fork-tools-subagents.md): new-session tool presets and Chat only, exact system prompts through `before_agent_start`, built-in subagents (setting, disabled built-ins, profile files, notifications).
- [fork-files-security.md](docs/agents/fork-files-security.md): security posture (web password, OAuth tokens, preview sandboxes), worktrees and branch switching, the file access allow-list, web password throttling.
- [fork-desktop.md](docs/agents/fork-desktop.md): the Tauri shell (desktop token, native menus in Rust, file context menu, window state, tauri plugin version pairing), workspace terminals and node-pty / quickjs staging, Windows overwrite installs.
- [fork-ui.md](docs/agents/fork-ui.md): who contains whom in the topbar / chat column / right panel, the settings dialog tabs, touch affordances, completion sound, plugins and skills.
- [fork-chat-workspace.md](docs/agents/fork-chat-workspace.md): the non-project Chats section, the hidden `chat-workspace` cwd and `workspaceKind` identity, project-workbench suppression, and the server-enforced no-tools / no-shell / no-context-files policy.

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)

### Hard rules
Each one undid a real regression; the linked note has the reasoning.
- `AgentSessionWrapper.isRunning()` ORs in `inner.isIdle === false`; dropping it evicts wrappers mid-retry. ([fork-sessions](docs/agents/fork-sessions.md))
- Never assign `agent.state.systemPrompt` (a getter since pi 0.86). Exact prompts go only through `lib/exact-system-prompt.ts`; do not add a second path. ([fork-tools-subagents](docs/agents/fork-tools-subagents.md))
- `useAgentSession`: keep the monotonic request ids, `fetchWithRetry` for the session load, `seedStreamingSnapshot()`, the render-phase scroll save, and the `sessionHookMountedRef` re-assert before `maintainEventsConnected()`. ([fork-sessions](docs/agents/fork-sessions.md))
- The composer sends exactly one `onSend` per submit; a second raw send restores the text into the box. ([fork-sessions](docs/agents/fork-sessions.md))
- Do not re-add the legacy `auto_compaction_*` event cases or a manual DeepSeek xhigh clamp. ([fork-sessions](docs/agents/fork-sessions.md))
- `enabledModels`: never compare patterns as strings, never assume `provider/*` covers a provider, never rebuild the list from `getAvailable()`; every toggle is a minimal edit and only `resync` repairs entries. ([fork-models](docs/agents/fork-models.md))
- Provider catalogs refresh over the network only when the user presses "Refresh catalog". ([fork-models](docs/agents/fork-models.md))
- Credential deletes go through `removeStoredCredentialIfType()`, and both provider lists refresh after any auth change. ([fork-models](docs/agents/fork-models.md))
- Built-in subagent profiles are switched off by name in `disabledBuiltIns`, never copied out to a `.md`; keep `SUBAGENT_NOTIFICATION_PREFIX` in code. ([fork-tools-subagents](docs/agents/fork-tools-subagents.md))
- Never give one iframe both `allow-scripts` and `allow-same-origin`; keep `SERVE_EXT_TO_MIME` in `getServeMime`. ([fork-files-security](docs/agents/fork-files-security.md))
- Manual-code OAuth handshake tokens are `crypto.randomUUID()`. The auth throttle stays global, and its reset window stays longer than the max delay. ([fork-files-security](docs/agents/fork-files-security.md))
- No literal `homedir()` in session-scanner fs calls; use `userHome()`. ([fork-sessions](docs/agents/fork-sessions.md))
- Native-dialog routes (`/api/desktop/*`, `?type=import`) require the per-process desktop token; never a static token or User-Agent check. `read-images` derives its cap from `MAX_ATTACHED_IMAGES`. ([fork-desktop](docs/agents/fork-desktop.md))
- Open local paths with `explorer.exe` on Windows, never `cmd.exe /C start`. ([fork-desktop](docs/agents/fork-desktop.md))
- Native popup menus are built in Rust (`show_popup_menu`); do not go back to the JS `Menu` API. ([fork-desktop](docs/agents/fork-desktop.md))
- `tauri-plugin-*` crates and `@tauri-apps/plugin-*` packages stay on the same minor; fix drift in `Cargo.lock`, never by pinning npm down. ([fork-desktop](docs/agents/fork-desktop.md))
- Window state flags are `SIZE | POSITION | MAXIMIZED`; never `VISIBLE` or `DECORATIONS`. ([fork-desktop](docs/agents/fork-desktop.md))
- After an SDK bump run `npm run desktop:prepare && npm run desktop:verify`; never hard-code a nested staging destination; keep all three Windows `node_modules` guards. ([fork-desktop](docs/agents/fork-desktop.md))
- Layout: the center column contains topbar and chat; the right-panel block is a full-height sibling inside the outer row; no `paddingLeft: sidebarResizer.width` on the topbar. Pinned by `AppShell.right-panel-row.test.mjs`. ([fork-ui](docs/agents/fork-ui.md))
- `SettingsPanel` keeps the `onBusyChange` guard so a desktop update cannot be dismissed mid-install. ([fork-ui](docs/agents/fork-ui.md))
- Chats use a server-owned hidden cwd and `workspaceKind`; never derive that path in the browser, group it with projects, or expose it to project trust / worktrees / files / terminals. Server policy must keep chats tool-less, shell-less, and context-file-free even for persisted sessions. ([fork-chat-workspace](docs/agents/fork-chat-workspace.md))

---

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Upstream merge sentinels (not the same "fork" as session fork)
This repo is a fork of `agegr/pi-web` and periodically merges upstream. `components/fork-extractions.test.mjs` guards the failure mode that a clean merge can still be wrong: code this fork *moved* to another file reappears at its origin, or a fork change is silently reverted. Git does not track cross-file moves, so neither shows up in `tsc`, eslint, or the upstream suite.

When one of those assertions fails, the default is to restore the behaviour, not to delete the assertion. A failure saying a marker is "absent from the origin but also from the extraction targets — it looks deleted, not moved" means the feature is probably gone: that is exactly how the project-picker filter box was found missing after a restyle had left every project past the 7-row cap unreachable. Risk levels live in `scripts/fork-ownership.json`; the reasoning is in `docs/ownership-boundaries.md`.

The third direction is `forbiddenMarkers` on a `FORK_FEATURES` entry: a region the *fork* deleted that upstream still ships. A clean merge re-adds it silently, so the entry asserts those strings stay absent from the file (currently the new-session branding header in `components/ChatWindow.tsx`). A failure there means "put the removal back", never "drop the marker".

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

**UI consistency is mandatory (user requirement).** Every application menu, dropdown,
option picker and autocomplete popup must use the shared `.app-menu` surface and menu
tokens in `app/native-theme.css`. Form choices use `components/AppSelect.tsx`; do not
introduce raw `<select>` controls or OS-native application option menus. Preserve the
same palette, nested radii, inset, row spacing, selected/disabled states and focus
treatment in both themes. Use the existing design as the reference, consult the
sources in `docs/ui-menu-audit.md`, and inspect actual rendered states at desktop and
narrow widths before claiming visual consistency. System file/directory dialogs are
separate OS tasks. Run `node --test scripts/ui-menu-consistency.test.mjs` after menu work;
changes to shared choices also run `node e2e/option-controls.mjs`.

`app/globals.css` and `app/settings.css` are pi-web's and stay byte-identical to upstream — `scripts/upstream-css-baseline.test.mjs` fails on any edit. Put every fork rule in `app/native-theme.css` (imported last in `app/layout.tsx`); overrides of upstream rules that other theme rules must beat go in its "fork base layer" at the top. After an upstream merge run `node scripts/upstream-css-baseline.mjs update <upstream-ref>` (the sync workflow does). Layout of the theme file and the design intent to restore after a merge: `docs/native-theme.md`.

## CSS Variables (`app/globals.css`, re-tokened in `app/native-theme.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```
