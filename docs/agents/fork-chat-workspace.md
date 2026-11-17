# Non-project chats — fork notes

Chats are a first-class sidebar section beside Projects, but not a second
session system. They reuse the existing `SessionInfo`, JSONL, SSE, fork, search,
running-state, and persistence paths. What is new is that **every chat owns a folder**
(its cwd), so a chat can keep the files it makes, while a stricter policy keeps it away from
a shell and from the rest of the computer until the user says otherwise.

## Workspace identity

- `lib/chat-workspace.ts` owns `~/.pi/agent/chats` (derived from `getAgentDir()`), the
  **chat root**. The root is not a chat's cwd: it is what a brand-new chat is *requested*
  with. `startRpcSession()` swaps it for `createChatFolder()`
  (`~/.pi/agent/chats/YYYYMMDD-HHMMSS-xxxxxxxx`, private, unique) before the session exists,
  so the browser never builds a chat's path.
- `isChatWorkspacePath()` is true for the root, for a direct child of the root
  (`isChatFolderPath()`, a chat that owns a folder) and for the **legacy** shared cwd
  `~/.pi/agent/chat-workspace` (`isLegacyChatWorkspacePath()`, chats made before folders).
  Legacy chats keep their original policy (below); they are never migrated.
- `ensureChatCwd()` recreates a chat's folder (or the legacy cwd) when an existing chat
  starts; `pruneEmptyChatFolders()` (hourly, from `GET /api/sessions`) removes folders that
  stayed empty for a day and that no session points at: composers that prepared a chat to
  load its commands and never sent anything.
- `GET /api/chat-workspace` creates and returns the root. `GET /api/sessions` also returns it
  as `chatWorkspaceCwd`, so the sidebar and shell share one server-owned answer for "new chat".
- `attachSessionProjectInfo()` in `lib/session-reader.ts` sets `workspaceKind: "chat"`
  (plus `chatFolder: true` for a chat with its own folder) and removes `projectRoot`,
  `projectKey`, `branch`, and `isWorktree`. Project sessions receive `workspaceKind: "project"`.
- `POST /api/cwd/validate` recognizes the root, a chat folder and the legacy cwd and returns
  the same server identity instead of treating them as a project.

The browser must never construct or compare a chat path by string derivation. It uses
`workspaceKind`, `chatFolder`, the `/api/chat-workspace` answer, or the `chatWorkspaceCwd`
returned by `/api/sessions`.

## UI boundaries

- `components/SessionSidebar.tsx` renders Chats above Projects, five session
  families at a time with "Show more", and keeps the section available when
  there are no projects.
- Chats never enter `groupByProject()`, recent projects, project pickers,
  worktree lookup, project trust, terminals, or Scheduled's project roots. The right
  panel is theirs only as a viewer of their own folder (see "Files on this computer").
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
(`chat`, `chat-unlocked`, `chat-only` or `project`; capabilities: files and shell, loads
extensions, tool presets, exact prompt). The wrapper holds it and `isChatOnly()` /
`isChatWorkspace()` (limited chat) / `isChatUnlocked()` / `isChat()` read from it. The
browser never computes it: it reads the server-classified `workspaceKind`. A chat sends Pi's
structured prompt with a chat preamble, so its transcript matches what is sent; only a
`chat-only` project session still sends an exact prompt.

## Server-enforced policy

Client checks are affordances only; the server enforces the policy
(`lib/chat-workspace-policy.ts`).

A chat loads extensions, skills, prompt templates and the codemode / tool-search /
MCP built-ins like a project session. What it never gets of its own is a shell or the
user's filesystem:

- **A chat with a folder** (every chat made since folders) keeps `read`, `write`, `edit`,
  `grep`, `find` and `ls`, **all confined to its folder** (`chatFolderToolBlockReason`):
  relative paths start there, the target is judged after `realpath` of its deepest existing
  ancestor (so `..`, `~`, absolute paths and symlinks inside the folder that lead out are
  refused, and a new file is judged by where it would land), and a `find` pattern or `grep`
  glob that is absolute, starts with `~` or climbs with `..` is refused. `read` additionally
  opens skill files and a file the **user named by full path in their own message**
  (read-only, below). `bash` and `powershell` are always blocked.
- **A legacy chat** (no folder) keeps its old loadout: `read` for skills and named files,
  `save_to_downloads` as its one write, every other coding tool blocked.
- **MCP tools run only when their server marks them read-only** (`readOnlyHint: true`);
  the chat's `tool_call` guard blocks the rest, nested codemode calls included. A tool the
  user lists in Settings › Chats › "Extra tools allowed in chats" bypasses that check (the
  user named it). This replaces the earlier "MCP may write" decision, which made "no shell"
  meaningless for anyone with a filesystem or shell MCP server.
- Default tools (`CHAT_FOLDER_DEFAULT_TOOL_NAMES` / `CHAT_DEFAULT_TOOL_NAMES`): the file
  tools above (or `read` + `save_to_downloads`), `codemode`, `tool_search`, the read-only web
  tools (`web_search`, `fetch_content`, `source_check`, `get_search_content`), read-only MCP
  tools, plus the names the user lists in Settings › Chats (`isChatToolAllowed`; stored as
  `chats.allowedTools`, validated by name, read on every run and call, and never lifting a
  blocked coding tool). Every other tool an installed extension registers (file readers,
  computer or browser control, sub-agents) stays off until the user adds it: the
  `before_agent_start` handler narrows `selectedTools` on every run, startup, reload and
  tree navigation filter the active set, and a `tool_call` guard blocks the rest.
- Extensions that register a delegation tool (`Agent`, ...) are not loaded, because a
  sub-agent would carry the file access a chat is denied.
- `POST /api/agent/new` ignores any requested tool preset for a chat, and
  `startRpcSession()` re-detects the workspace from the session file, so an old chat
  with a stale `pi-web:tool-selection` entry gets the same policy. No selection is
  recorded for a chat.
- Context files (global, ancestor, project) never load: `noContextFiles`.
- The prompt is Pi's structured prompt with a custom preamble (`chatWorkspacePrompt`) plus
  `date` and `artifacts` sections. For a chat with a folder `cwd` names the folder, so
  relative paths in tool calls are anchored there; the legacy cwd is replaced by `(none)`.
- `get_tools` lists the chat's tools (blocked coding tools hidden), `get_commands`
  returns the real commands (skills, prompt templates, extension commands),
  `set_tools` is rejected for every chat and `bash` for a limited one.

`chatOnly` and `chatWorkspace` are different flags. `chatOnly` means a project
session with an empty tool allow-list (exact context-file prompt, nothing loaded);
`chatWorkspace` means a limited non-project chat.

### Letting one chat use the computer

`lib/chat-unlock.ts` records the choice as a session entry (`pi-web:chat-unlock`, newest
wins), so it outlives the process and is per chat. `POST /api/sessions/[id]/chat-access
{ unlocked }` (`setRpcChatUnlock`) appends it, shuts the wrapper down and starts it again;
the client then re-attaches like after a tool-preset change (`handleChatAccessRebuilt`).

- An unlocked chat (`chat-unlocked` policy) keeps the chat prompt, `date`/`instructions`
  sections, its folder as cwd and `noContextFiles`, but the workspace extension registers no
  tool guard and does not narrow the tools: it has pi's default tools including `bash`, the
  whole filesystem, and MCP tools that may write (the prompt says so).
- Only a chat **with a folder** whose session file exists can be unlocked (pi writes a
  session out once it has an assistant message; an entry added earlier would be lost in the
  restart) and never while it runs. A server open to other machines (`isNetworkExposedServer`)
  never honours it: the switch is hidden, the POST fails and `startRpcSession()` ignores a
  stored unlock.
- The switch lives in the composer's run menu (`ChatAccessRows`) and applies at once, no
  confirmation; switching it off goes back to the folder-confined loadout.
- When the model asks for a shell the chat does not have, the refusal starts with
  `CHAT_SHELL_BLOCK_MARKER` (`lib/chat-shell-block.ts`). If that happened in the latest turn
  and the chat can be unlocked, `ChatShellPrompt` shows above the composer; "Allow and
  continue" unlocks the chat and sends a short message asking the model to carry on.

## Files on this computer: the chat folder, naming a path

`lib/chat-file-access.ts`. Reading a named path acts on the machine that runs Pi, so it is
off (and the prompt says so) when `PI_WEB_HOSTNAME` is a non-loopback address
(`isNetworkExposedServer`). The chat's own folder is not affected by that.

- **The chat's folder.** Everything a chat creates lives in its folder; the user finds it
  from the composer's run menu ("Show chat folder", `POST /api/chat-folder/reveal`, which
  looks the folder up from the session, loopback only; the desktop shell uses
  `revealItemInDirNative`). The same folder also opens **in the right panel**: a chat with a
  folder (`session.chatFolder`) passes its `cwd` to `ChatWindow` as `messageCwd` and an
  `onOpenFile`, so the "files edited" card, markdown file links and inline-code paths open in
  `FileViewer` exactly as in a project, and `AppShell` shows the folder's file tree
  (`workbenchCwd = visibleProjectCwd ?? chatFolderCwd`) behind the topbar panel toggle.
  `handleOpenFile` only accepts paths inside that folder (`isPathInside`), so a link to
  anything else does nothing. The panel is reset on every chat switch and when leaving a chat.
  Terminals, project trust, `@` mentions and artifact tabs stay project-only; a legacy chat has
  no folder and gets no panel (`AppShell.chat-workspace.test.mjs`,
  `ChatWindow.chat-folder-files.test.mjs`).
- **Reading a named path.** `ChatFileGrants` collects the paths in the user's own messages
  (`extractUserNamedPaths`: absolute, `~/`, `file://`, Windows drive paths; bare, or quoted
  when they contain spaces) from `before_agent_start` events of type `user` and, once per
  reopened chat, from the transcript's user messages. Tool results, web pages and the
  model's own text never grant anything, and neither does an attached file: its
  `<attached_file>` block is cut out (`splitAttachedFiles`) before the scan, because its text
  is someone else's. A grant is a candidate: at read time it must resolve (through
  `realpath`) to the requested existing regular file. Credentials and keys are never
  readable even when named (`isSensitivePath`: `~/.ssh`, `~/.aws`, `~/.gnupg`,
  `.netrc`/`.npmrc`, Pi's own `*.json` settings and keys). A named path is read-only; writes
  stay in the folder.
- **Legacy chats only: `save_to_downloads`.** (`lib/chat-downloads-tool.ts`) a bare file name
  written into Downloads without replacing anything, up to 8 MB; its result renders as a
  `SavedFileCard` (kept so old transcripts still show the card) with "Show in folder"
  (`POST /api/chat-downloads/reveal`). It saves without asking (the old
  `chats.confirmSave` switch was removed). A chat with a folder does not get this tool.

## Text attachments

A picked or dropped text file (`lib/chat-attachments.ts`: text/code/data extensions, 256 KB
each, 512 KB and five files per message, UTF-8 without NUL) becomes a chip in the composer
and travels inside the message as an `<attached_file name="...">` block appended after the
typed text, so the model always has it. `MessageView` renders those blocks as expandable
chips (`AttachedFileList`), `attachmentAwareTitle()` keeps them out of session titles, and
the session scanner uses it for `firstMessage`. Images keep their own path. A Word `.docx`
is read as plain text by `POST /api/chat-attachments/extract` (mammoth, body-only, 10 MB in,
the same 256 KB of text out) and then attached like any text file. PDF and other Office
files are rejected with a message; a PDF needs a parser dependency.

In the full composer (projects and chats), a single paste of at least 2,000 UTF-16
code units becomes a `Pasted text.txt` attachment. It keeps the clipboard's plain text
and the textarea's existing value/selection; repeat names get a numbered suffix.
The same byte/count limits apply, and rejection leaves the textarea untouched with
an inline reason. Compact text-only composers keep normal paste behavior. File
chips can preview their contents or insert them at the textarea selection as text.
The attachment uses the existing draft/send/restore protocol; it still consumes
model context. At send admission, `useAgentSession` parses the attached-file
blocks as well as image attachments before classifying `!` / `!!` shell input:
a message with a text attachment goes to the model unchanged, even if its typed
text starts with `!`. Ordinary attachment-free shell commands retain their prior
behavior. On the server, file-bearing submissions use the SDK's
`expandPromptTemplates: false` option, so `/extension`, `/skill:*` and prompt
templates remain literal model input. This applies to direct prompts, outbox
send-now/automatic deliveries, legacy steer/follow-up commands and compaction
replay; attachment-free commands retain normal SDK dispatch. Input hooks still
run. `hooks/useAgentSession.attachment-admission.test.mjs` executes the real
send-admission prefix to verify that no shell invocation receives file payloads;
`lib/rpc-manager-attached-prompts.test.mjs` exercises wrapper admission through
the actual SDK command dispatcher without contacting a model. `PLAYWRIGHT_CHANNEL=chrome node e2e/long-paste.mjs` covers the browser
flow, checks real light/dark palette changes, and asserts no horizontal overflow
or clipped attachment actions at 1200/390/320px. It writes screenshots to
`test-results/long-paste/`.

A chat with a folder also keeps a copy of each text attachment in
`<folder>/attachments/` (`lib/chat-attachment-files.ts`, called from the `prompt` command of
the wrapper): a file with the same name and content is not saved twice, a taken name gets
` (1)`, a name that is hidden, has a path or a program extension is made safe. The copy never
fails a send. Only text reaches the folder; binary files are not attachable yet.

## Continue in a project

`POST /api/sessions/[id]/continue-in-project { cwd }` (row menu "Continue in project…",
chats only) copies the chat with `SessionManager.forkFrom()` into a new session in the
chosen project and leaves the chat alone. The copy drops the chat's system messages
(they declare the chat's tool loadout, which pi would restore) and records a cleared
tool selection, so the project session builds its own prompt and default tools. The files
the chat made stay in its folder; the response carries `chatFolder` and the sidebar shows
where they are. A chat that is still running is refused.

## Deleting and forking

Deleting a chat that owns a folder asks in a dialog ("Also move the chat's folder to the
Trash", on by default): `DELETE /api/sessions/[id]?chatFolder=trash`. The folder goes to the
system Trash (`lib/trash.ts`: `~/.Trash` on macOS, the XDG Trash on Linux, an app-owned
`chats-trash` elsewhere) and only when no other session still uses it. A fork of a chat
shares its parent's folder, so deleting one of them keeps the folder. Archiving keeps it.

## Tests

- `lib/chat-workspace.test.mjs` covers path ownership (root, folder, legacy), folder
  creation, `ensureChatCwd` and pruning. `lib/chat-unlock.test.mjs`, `lib/trash.test.mjs`
  and `lib/chat-attachment-files.test.mjs` cover the unlock entry, the Trash move and the
  attachment copies.
- `lib/chat-groups.test.mjs`, `lib/chat-settings.test.mjs` and `lib/session-policy.test.mjs`
  cover pin ordering, the settings block and the policy derivation.
- `lib/chat-workspace-policy.test.mjs` pins the server-side policy and exercises the
  folder-confined file tools, the read-only MCP gate, the unlocked chat, the tool
  allow-list, the date section and the delegation filter. `lib/chat-attachments.test.mjs` covers the text-attachment round trip.
- `components/AppShell.chat-workspace.test.mjs` pins server-provided
  classification and project-workbench suppression.
- `components/SessionSidebar.test.mjs` and the session-search tests pin the
  Chats section, project separation, pagination, and path-safe search labels.
