# Non-project chats — fork notes

Chats are a first-class sidebar section beside Projects, but not a second
session system. They reuse the existing `SessionInfo`, JSONL, SSE, fork, search,
running-state, and persistence paths. The only new backing concept is a hidden
cwd that Pi requires for every session.

## Workspace identity

- `lib/chat-workspace.ts` owns `~/.pi/agent/chat-workspace` (derived from
  `getAgentDir()`), lazy directory creation, and exact-path recognition through
  `samePath()`.
- `GET /api/chat-workspace` creates and returns that cwd. `GET /api/sessions`
  also returns it as `chatWorkspaceCwd`, so the sidebar and shell can share one
  server-owned answer.
- `attachSessionProjectInfo()` in `lib/session-reader.ts` sets
  `workspaceKind: "chat"` and removes `projectRoot`, `projectKey`, `branch`, and
  `isWorktree`. Project sessions receive `workspaceKind: "project"`.
- `POST /api/cwd/validate` recognizes the hidden cwd and returns the same
  server identity instead of treating it as a project.

The browser must never construct or compare the hidden path by string
derivation. It uses `workspaceKind`, the `/api/chat-workspace` answer, or the
`chatWorkspaceCwd` returned by `/api/sessions`.

## UI boundaries

- `components/SessionSidebar.tsx` renders Chats above Projects, five session
  families at a time with "Show more", and keeps the section available when
  there are no projects.
- Chats never enter `groupByProject()`, recent projects, project pickers,
  worktree lookup, project trust, the file tree, the right workspace panel,
  terminals, or Scheduled's project roots.
- `AppShell` closes and suppresses project-only chrome while a chat is active.
  The window title and topbar subtitle never expose the hidden cwd.
- `ChatInput` disables `@` file completions and hides `#` session mentions and `!`
  shell mode. The attach button and drops accept images, and text files as chips
  (below).
- The Chats header is a fold toggle like a project row: its title folds the section,
  the hover-only "…" (collapse / expand) and "+" sit in `.sidebar-project-tree-tools`,
  and the fold plus the number of extra pages persist (`collapsedChats`,
  `chatSessionPages`). Folding drops the extra pages, so unfolding shows five again;
  every "Show more" adds five. A search ignores the fold.

- Chats can be pinned and archived from the row menu (`lib/chat-groups.ts`). Pinned chats
  come first (a pin mark on the row), the rest by recency; there are no Today / This week
  headings because every row already shows its relative time. The +5 paging runs over that
  whole order. Archived chats leave the list (a search still finds them) and sit behind
  "Show archived (N)" with an Unarchive entry. Pin and archive are browser preferences like
  archived projects (`pinnedChats`, `archivedChats`), keyed by the chat's root session id.

## Settings › General › Chats

`lib/chat-settings.ts` keeps the chat-only preferences under `chats` in Pi Web's own
`pi-web/settings.json` (never pi's settings.json): a default model, a reasoning level and
the user's own instructions (8000 characters) and the extra tool names above. Unset means "follow the global default" and
the block never writes the global default, so a saved reasoning level of `max` stays `max`
for projects. `lib/chat-settings-shared.ts` holds the client-safe constants: the Settings
panel is a client component and must not import the server module.

- A brand-new chat starts on the chosen model (only while it is still enabled) and level;
  an explicit pick for that session wins. `startRpcSession()` applies it for chats with no
  messages, and `GET /api/models` applies the same for the hidden cwd, so the composer
  shows what will start. Saving invalidates the model cache.
- The instructions are re-read on every run and sent as an `instructions` prompt section,
  so an edit applies to the next prompt. They never reach project sessions.
- `PUT /api/chat-settings` validates the patch (`validateChatSettingsPatch`) and rejects
  untrusted origins like the artifacts switch.

## Session policy

`lib/session-policy.ts` derives one `SessionPolicy` per session when it starts
(`chat`, `chat-only` or `project`; capabilities: files and shell, loads extensions, tool
presets, exact prompt). The wrapper holds it and `isChatOnly()` / `isChatWorkspace()` read
from it. The browser never computes it: it reads the server-classified `workspaceKind`.
A chat sends Pi's structured prompt with a chat preamble, so its transcript matches what is
sent; only a `chat-only` project session still sends an exact prompt.

## Server-enforced policy

Client checks are affordances only; the server enforces the policy
(`lib/chat-workspace-policy.ts`).

A chat loads extensions, skills, prompt templates and the codemode / tool-search /
MCP built-ins like a project session, but the user's files and shell are reachable only
in two narrow, user-bound ways (below):

- Default tools (`CHAT_DEFAULT_TOOL_NAMES`): `read` (confined), `codemode`, `tool_search`,
  `save_to_downloads`, the read-only web tools (`web_search`, `fetch_content`,
  `source_check`, `get_search_content`) and every MCP tool, plus the names the user lists
  in Settings › Chats › "Extra tools allowed in chats" (`isChatToolAllowed`; stored as
  `chats.allowedTools`, validated by name, read on every run and call, and never lifting a
  blocked coding tool). Every other tool an installed extension registers (file readers,
  computer or browser control, sub-agents) stays off until the user adds it: the
  `before_agent_start` handler narrows `selectedTools` on every run, startup, reload and
  tree navigation filter the active set, and a `tool_call` guard blocks the rest, nested
  codemode calls included. `bash`, `powershell`, `edit`, `write`, `grep`, `find` and `ls`
  are always blocked.
- `read` opens skill files (a loaded skill's folder, or a single-file skill, after
  `realpath`, so `..` and symlinks cannot leave it), a file the chat saved, and a file the
  **user named by full path in their own message** (below).
- Extensions that register a delegation tool (`Agent`, ...) are not loaded, because a
  sub-agent would carry the file access a chat is denied.
- `POST /api/agent/new` ignores any requested tool preset for the hidden cwd, and
  `startRpcSession()` re-detects the workspace from the session file, so an old chat
  with a stale `pi-web:tool-selection` entry gets the same policy. No selection is
  recorded for a chat.
- Context files (global, ancestor, project) never load: `noContextFiles`.
- The prompt is Pi's structured prompt with a custom preamble
  (`CHAT_WORKSPACE_PROMPT`) plus `date` and `artifacts` sections; `cwd` is replaced
  by `(none)`. It is no longer an exact empty prompt, so the transcript matches what
  is sent.
- `get_tools` lists the chat's tools (blocked coding tools hidden), `get_commands`
  returns the real commands (skills, prompt templates, extension commands),
  `set_tools` and `bash` are rejected with a message pointing the user to a project.

`chatOnly` and `chatWorkspace` are different flags. `chatOnly` means a project
session with an empty tool allow-list (exact context-file prompt, nothing loaded);
`chatWorkspace` means the hidden non-project workspace above.

## Files on this computer: reading what the user names, saving to Downloads

`lib/chat-file-access.ts`, `lib/chat-downloads-tool.ts`. Both act on the machine that runs
Pi, so they are off (and the prompt says so) when `PI_WEB_HOSTNAME` is a non-loopback
address (`isNetworkExposedServer`).

- **Reading.** `ChatFileGrants` collects the paths in the user's own messages
  (`extractUserNamedPaths`: absolute, `~/`, `file://`, Windows drive paths; bare, or quoted
  when they contain spaces) from `before_agent_start` events of type `user` and, once per
  reopened chat, from the transcript's user messages. Tool results, web pages and the
  model's own text never grant anything. A grant is a candidate: at read time it must
  resolve (through `realpath`) to the requested existing regular file. Credentials and keys
  are never readable even when named (`isSensitivePath`: `~/.ssh`, `~/.aws`, `~/.gnupg`,
  `.netrc`/`.npmrc`, Pi's own `*.json` settings and keys).
- **Writing.** `save_to_downloads(filename, content, encoding?)` is the only write a chat
  has. A bare file name (no folder, no `..`, no hidden files, no program or installer
  extensions), written into the Downloads folder (`XDG_DOWNLOAD_DIR`, else
  `~/Downloads`) without ever replacing a file (`name (1).ext`), up to 8 MB, mode 0644. The
  result's details (`path`, `name`, `size`) render as a `SavedFileCard` with "Show in
  folder" (`revealItemInDirNative` on the desktop, `POST /api/chat-downloads/reveal`
  elsewhere, loopback only and Downloads only). "Ask before a chat saves a file" in
  Settings › Chats (`chats.confirmSave`) makes each save go through the extension UI's
  confirm dialog.

## Text attachments

A chat has no project to copy files into, so a picked or dropped text file
(`lib/chat-attachments.ts`: text/code/data extensions, 256 KB each, 512 KB and five files
per message, UTF-8 without NUL) becomes a chip in the composer and travels inside the
message as an `<attached_file name="...">` block appended after the typed text.
`MessageView` renders those blocks as expandable chips (`AttachedFileList`),
`attachmentAwareTitle()` keeps them out of session titles, and the session scanner
uses it for `firstMessage`. Images keep their own path. A Word `.docx` is read as plain
text by `POST /api/chat-attachments/extract` (mammoth, body-only, 10 MB in, the same 256 KB
of text out, nothing written to disk) and then attached like any text file. PDF and other
Office files are rejected with a message; a PDF needs a parser dependency.

## Continue in a project

`POST /api/sessions/[id]/continue-in-project { cwd }` (row menu "Continue in project…",
chats only) copies the chat with `SessionManager.forkFrom()` into a new session in the
chosen project and leaves the chat alone. The copy drops the chat's system messages
(they declare the chat's tool loadout, which pi would restore) and records a cleared
tool selection, so the project session builds its own prompt and default tools. A chat
that is still running is refused.

## Tests

- `lib/chat-workspace.test.mjs` covers path ownership and private directory
  creation.
- `lib/chat-groups.test.mjs`, `lib/chat-settings.test.mjs` and `lib/session-policy.test.mjs`
  cover pin ordering, the settings block and the policy derivation.
- `lib/chat-workspace-policy.test.mjs` pins the server-side policy and exercises the
  skill-confined `read`, the tool allow-list, the date section and the delegation
  filter. `lib/chat-attachments.test.mjs` covers the text-attachment round trip.
- `components/AppShell.chat-workspace.test.mjs` pins server-provided
  classification and project-workbench suppression.
- `components/SessionSidebar.test.mjs` and the session-search tests pin the
  Chats section, project separation, pagination, and path-safe search labels.
