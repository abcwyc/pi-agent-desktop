# Layout, settings and client behavior — fork notes

## Terminal appearance

`LazyTerminalPanel` caches the imported component and renders it synchronously after
idle preloading. Do not wrap it in `next/dynamic`: a separate React.lazy instance
still suspends on first mount and can add a 300ms fallback throttle even with cached
chunks. Preloading must only load code, never start a PTY. Terminal height follows
its workspace container, not the viewport.

TerminalPanel reads workbench surface, text, selection and semantic ANSI colors through
`lib/terminal-theme.ts`; its surrounding styles live in `app/native-theme.css`.
Root theme/background changes update xterm options in place, preserving the PTY,
scrollback and input. Minimum contrast is 4.5; light mode does not retain dark-only ANSI colors.
Run `node e2e/terminal-theme.mjs` for light/dark and narrow-layout regression checks.

## Streaming Markdown

`MarkdownBody` coalesces preprocessing snapshots at 48–96ms, then passes the
existing Pi components and remark/rehype safety pipeline to `StreamingMarkdown`.
The headless `@lobehub/streamdown` engine owns stable block caching, processor
reuse and paced word fades (`realtime`); no Lobe UI theme is imported. Completion,
stop and replacement flush authoritative text. A replaced stream starts a new
queue, and finished/user/history messages use the ordinary static renderer.

Reference links/footnotes, YAML frontmatter, raw HTML and display math keep one
syntax tree (`needsWholeMarkdownDocument`); conservative matches inside fences
also take that path. Reduced-motion users receive the unanimated renderer, with
no reveal backlog. Pi's existing code highlighting and delayed Mermaid/HTML
previews remain in charge; this change does not add streaming code highlighting.

Run `node e2e/streaming-markdown.mjs` for real-browser incremental replay, old vs
new parse-volume measurement, desktop/mobile light/dark snapshots, replacement,
stop, reduced motion, file links, document-wide syntax and HTML sanitization.
The fixture uses local generated content and never contacts a model. Results
and screenshots go to the ignored `test-results/streaming-markdown/` directory.

Fork-owned notes moved out of `AGENTS.md` to keep it short. The upstream doc on the same topic (`docs/agents/*.md` without the `fork-` prefix) may describe the same area in other words; where they disagree, these notes describe this fork. Hard rules that must survive a merge are also listed in `AGENTS.md` under **Hard rules**.

## Conversation find

`ConversationFind` is mounted by `ChatWindow`. Ctrl+F / Cmd+F searches the current
conversation's loaded, expanded text (not the sidebar, composer or file panel).
Opening reveals the loaded render window; older server pages are requested explicitly
with “Load earlier messages”, idle-only through the existing guarded `loadContext`.
Collapsed process content is not silently expanded or advertised as searched.
Literal case-insensitive DOM ranges use CSS Custom Highlights, never DOM text replacement,
so React, syntax highlighting and streaming remain intact. Enter / Shift+Enter cycle
matches; Escape closes without aborting the agent and restores focus. DOM refreshes
preserve the active range where possible (otherwise clamp its index), update counts
without scrolling, and only explicit navigation or query edits move the viewport.
Text traversal preserves document order and treats block elements, line breaks and
excluded controls as boundaries while allowing matches across inline formatting.
Session/leaf changes clear search; inert/hidden conversations never intercept find;
modal dialogs and focused file workspaces retain their own keys.
Run `node e2e/conversation-find.mjs` (or `PLAYWRIGHT_CHANNEL=chrome` for installed Chrome)
for real-component light/dark, narrow-width, keyboard, history and streaming checks.

## Conversation navigation
ConversationNavigator 仅在右侧工作面板关闭、对话滚动区宽度至少 1024px，且正文左边距至少 64px 时显示。
沿用 ResizeObserver 同时观察滚动区和实际正文列，因此侧栏缩放、窗口变化和正文宽度设置都会重新判断；
不可仅用窗口媒体查询推测可用空间。隐藏时移除导航及其键盘入口，并清理悬停预览，恢复显示时不主动滚动正文。
`node e2e/conversation-navigator.mjs` 覆盖真实导航组件的几何、面板开关、正文宽度及键盘交互。

## Touch affordances

Sidebar and topbar menus are placed from their measured size, never from a
guessed height: `lib/menu-placement.ts` flips a menu above its anchor when the
space below cannot hold it and keeps it inside the viewport, and
`hooks/useMenuPlacement.ts` applies that before the browser paints. A row near
the bottom of the window must not push its last entry (delete, remove project)
under the window edge. `node e2e/sidebar-menu-placement.mjs` covers the session
and project menus in both themes and languages.

The session-row more action reserves a 28px hit area. Its 20px painted highlight
is inset by the shared 4px choice gap on all sides, with the same 4px clearance
to the row's trailing edge. Keep the row/slot/button dimensions in CSS; do not
restore the old 24px inline slot and separate 7px row padding. The glyph and
highlight share a center in hover, keyboard-focus and open-menu states.

Session deletion uses the shared `ChatConfirmDialog`; do not swap the 28px session
row for inline Delete/Cancel buttons. Keep the row and title visible, show the full
name separately from the consequence, and use the shared neutral/soft-danger actions
with an 8px gap. Menu and Delete-key entry points share this confirmation, including
the optional chat-folder checkbox; Shift+click retains its existing bypass. Keep the
dialog open while deleting, with local errors and retry, and restore row focus on cancel.

Session rows render the "…" action menu when `(hovered || touchMode)` — `touchMode` is a post-mount `matchMedia("(hover: none)")` check, so hover styling is untouched on desktop and rename/delete stay reachable on touch. The composer's single circular action shows Stop while a run is active and the draft is empty; typing switches it to queued Send, including on narrow screens. Escape remains available to stop while drafting. Rename/delete failures use the global shell notice shelf (`appNotify.error` with `sidebar.renameFailed` / `sidebar.deleteFailed`) instead of being swallowed.
Message-row copy/edit/fork actions use CSS hover/focus-within reveal instead of JS hover state, and are always visible under `(hover: none)`. They must remain pointer-enabled when focused so keyboard tabbing does not land on invisible controls.
While a session runs, in-session "Edit from here" stays visible but disabled with the Esc hint; fork stays available because it copies to an independent file.

## Global operation notices
Persistent operations use `persistent: true` and replace their progress notice with
`updateAppNotice` when they settle. An update cannot revive a dismissed notice;
success resets the normal expiry deadline, while actionable errors remain visible.
Generate title uses this shelf after its menu closes, including a Models shortcut
for failures. Retry reuses the operation's notice and clears the old error action.
The shelf starts below the 48px toolbar with a 12px gap and sits below menus and
dialogs, so notices cannot block retry or window controls. Its surface uses the
shared radius, spacing and semantic colors in both themes.

`lib/notification-store.ts` and `components/AppNoticeShelf.tsx` own cross-surface shell notices (`appNotify.info/success/warning/error`). They queue and expire automatically, but a notice with an action stays until dismissed so the action cannot vanish. Keep errors beside the affected control when position carries meaning; use the shelf when the action comes from a global surface such as the sidebar or workspace shell. Do not claim Undo in one of these notices unless the data path really restores the original state — session DELETE currently unlinks files and cascades subagents, so it has no safe client-side undo.

## Keyboard shortcuts
`hooks/useKeyboardShortcuts.ts` owns app-level shortcuts. Cmd/Ctrl+\ closes the right workspace (never bare `\`), Cmd/Ctrl+/ opens the shortcut reference dialog, Cmd/Ctrl+B toggles the sidebar, and Cmd/Ctrl+L focuses the composer. Browser-reserved variants may not fire in the web build; the desktop shell receives them. Help must not layer over Settings or let another global shortcut fire through it: pass the other callbacks as `undefined` while it is open, then focus the dialog, capture Escape (so closing it does not also stop a run), and keep Tab inside the dialog.
The sidebar project tree is a keyboard `tree`: rows move focus with Up/Down/Home/End, project and subagent groups expand/collapse with Right/Left, Enter/Space activates, F2 starts rename, and Delete opens the same shared confirmation dialog as the row menu. Roving-tabindex extraction is intentionally not used yet because timeline rows and future non-session tree rows still need one shared focus model.

## Projects pane views
The Projects header's hover-only `…` menu switches between `grouped` (project rows with nested session families) and `timeline` (all top-level session families sorted by the root session's `modified` time, with each row's project name after the title). The choice persists in `APP_PREF_KEYS.projectViewMode`. Collapse/expand-all remain grouped-view actions; switching modes never rewrites the stored `collapsedProjects` set. The old Recent section is intentionally gone — the timeline replaces it. Desktop uses `showNativeMenu` check items, while the web build renders `ProjectViewMenu` as a DOM popover. In grouped view, "Show more" reveals five additional session rows per click; collapsing and reopening a project clears that page state so it starts from the latest five (`APP_PREF_KEYS.expandedProjects` stores root → extra pages).

## Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

## Claude-style home usage and pixel companion

Settings › Appearance has independent switches for the local usage dashboard and pixel
crab. Both default on; an explicitly saved false remains off. Preferences use
`APP_PREF_KEYS.homeDashboard` / `homeMascot`. ChatWindow mounts the dashboard only for
an empty new conversation; the companion follows model/tool activity, streaming text,
compaction, blocking extension input, errors and a short run-ended animation.
`lib/companion-sheets.ts` describes the reference sprite sheets in
`public/claude-companion/`; their separate artwork notice is retained in `NOTICE.txt`.
The player supports idle routines, sleep, click/tickle and horizontal dragging, pauses
when hidden and paints a still frame under reduced motion. Resize clamps the drag offset.
The Claude palette and prose typography live in `native-theme.css`; custom CSS still wins.
Proprietary Anthropic fonts and the reference's Sodium engine are not bundled.

The dashboard home uses the full remaining height above the bottom composer; the
classic centered composer's trailing flex spacer is rendered only when the dashboard
is off. The dashboard has no artificial overlay clearance; short viewports and expanded
model lists can still scroll when needed.

`HomeRipple.tsx` owns a non-interactive canvas below home content. Its glyph renderer,
noise and damped wave equation in `lib/home-ripple/` are adapted from the reference's
MIT home-ripple feature. Blank-area clicks reveal blue glyph waves; native controls do
not start waves. Resize recreates the field, theme changes invalidate it, hidden pages
pause, reduced motion renders a static field, and unavailable WebGL hides the effect.
`ChatWindow` arms a one-shot entrance only on local composer submission: the new user
bubble scales from its bottom-right corner. History loading and streaming reconciliation
do not replay it. Reduced motion disables entrance transforms. Verify the lifecycle with
`components/ChatWindow.message-motion.test.mjs` and glyph motion with the home E2E.

`GET /api/home-usage?range=all|30|7` reads only catalogue-owned local JSONL paths,
projects away content, and caches each range for up to 60 seconds. Sessions means files
created in the selected range; messages means user/assistant records across all branches,
not tool results. Copies with the same entry identity and timestamp (fork ancestry) count
once. Tokens sum recorded input, output, cache-read and cache-write buckets, including
usage/compaction entries, and may be incomplete; missing usage is not fabricated as a
known zero. Dates, ranges and peak hours use UTC. The blue activity grid covers the
latest 26 weeks, aligned to Sunday; the stacked model chart covers the latest 30 days.
Both retain their windows when the metric/ranking range changes. Daily model totals are
projected with the same fork deduplication as totals. Model ranking initially shows five
rows and expands to all recorded models. A time-based greeting heads the 480px panel
aligned with the composer's left edge; the visible home refreshes every minute/on focus.
No provider query, pricing estimate, prompt content or local path is returned.
Unreadable files are reported as partial data. No scan runs while the dashboard is off.

Validation: `node --test lib/home-usage.test.mjs` and
`node e2e/home-experience.mjs` (local mocked usage, real components, light/dark,
320–1280px, defaults/opt-out, persistence, reference sprite loading, click interaction,
states, reduced motion, model charts and error/retry).

## Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`. The switch is in Settings › General (`settings.completionSound`), not the composer row.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

## Settings dialog: one tab per concern
- The sidebar gear opens Settings directly through `openSettingsAtLastSection`, the same entry used by the keyboard shortcut. First use opens General; subsequent visits restore the last available section. Category navigation lives inside Settings; do not restore an intermediate section menu.
- The settings sections are `general`, `appearance`, `models`, `skills`, `agents`, `plugins`, `mcp` (`SETTINGS_SECTION_VALUES`). Appearance is available without a project and owns mode, background and the custom stylesheet through `AppearanceSettings.tsx`. General keeps language, chat controls, product/version information and the self-hiding desktop window/tray switches (`components/desktop/DesktopAppSection.tsx`). Do not duplicate appearance controls in General or reintroduce the former Desktop tab. `components/AppUpdatesSection.tsx` owns the update check and its chips.
- A signed desktop update installs and relaunches the app, so `AppUpdatesSection` reports `busy` up to `SettingsPanel`, which keeps backdrop clicks and Escape from dismissing the dialog mid-upgrade. That is the reason for the `onBusyChange` prop; don't drop it when refactoring the panel.
- `UpdateReminder` opens the panel at `general`, where the update status now lives. `components/fork-extractions.test.mjs` pins that the update/desktop code stays in those fork-owned files instead of being regrouped into `SettingsPanel.tsx`.

## Topbar, chat column, and right panel — who contains whom
Upstream segment D (0e36743) restructured `AppShell.tsx`'s main region in ways this fork's layout cannot survive; all three are pinned by `components/AppShell.right-panel-row.test.mjs`:

1. The "Center: chat" column must contain BOTH the topbar's chat content AND the chat wrapper. A merge variant closed the column right after the topbar, making the chat wrapper a second `flex: 1` row child — the viewport split 50/50 between an empty topbar-only column and the chat ("huge blank middle column, chat clipped at the right edge").
2. The right-panel toggle/backdrop/resizer/panel block must be inside the row, not after its close: as flex-**column** children of `.app-shell` the closed panel's content height still stole vertical space (`height: 432px` at `width: 0`), floating the composer.
3. Since 2026-09-24 the topbar sits inside a main column that follows the sidebar as a child of the outer row: `.app-shell` (column) → offline banner → outer row → [backdrop, sidebar (full height), sidebar handle, main column → [topbar, inner row → [center chat]], panel block]. The sidebar runs the full window height (its header hosts the macOS traffic lights via `session-sidebar-header--mac-inset`), and the topbar spans only the center column. Since 2026-10-14 the file panel block is a full-height sibling of the main column, drawn as an inset card (`--right-panel-gutter`, rules at the end of `app/native-theme.css`) that reaches the window top, like Claude Desktop's side panel; the card is one plain surface (no horizontal rules, the file tree white on its left, a × close in its header) on a canvas the topbar no longer tints or underlines, and its header row is a window drag region. `WindowControls` render in the topbar while the panel is closed and in the panel's header row while it is open, so they stay at the window's top-right corner. There is deliberately no `paddingLeft: sidebarResizer.width` on the topbar anymore — that was the old full-width-topbar hack that left a blank strip above the sidebar; re-adding it on a merge regresses the layout. `app-topbar--mac-inset` (72px) is only for the sidebar-closed/mobile case where the traffic lights land on the topbar itself.

The topbar renders exactly ONE toolbar group (`app-topbar-actions`: history/branches/more), pushed to the right edge by `margin-left: auto` — right-aligned since 2026-09-24 (a user request; an earlier experiment had it left of the title via `order: -1`, removed). The inline session-stats button (`renderSessionStatsButton`, ↑in ↓out ↻cache $cost) was removed the same day — session info opens from the More menu entry instead; `sessionStats`/`contextUsage` state stays (auto-name guards + More-menu labels). Segment D also left a second desktop group (`renderChatToolbarActions(false)` — history/generate-title/system/tools) next to it; the duplicate is removed, its unique entries (Sub-agents, Tools) live in the More menu via `handleSystemInfoToggle` (keeping the lazy dormant-session start), and its generate-title guards (persisted-stats counting + `selectedSession.transient` check) were merged into the group-A button — pinned by `AppShell.auto-name.test.mjs`. JSX indentation in AppShell.tsx is unreliable; verify structure with the TS AST or the DOM, not by counting whitespace. `fileContentBlock()` in `AppShell.file-viewer-state.test.mjs` slices source by the panel's closing-div sequence — keep in sync.
# 本地定制与桌面上游同步

单选菜单（Config、推理级别、模型、表单选择与项目/分支/worktree）与设置导航共用左侧蓝色短条和选中底色，不使用对号。默认值星标保持独立：空心星直接可点，保存成功后显示点亮的实心星，无底色、边框或阴影；保存时菜单保持打开。保留键盘焦点提示与 4px 行间距。

选项几何统一由 `app/native-theme.css` 的 `--choice-*` 定义：设置导航基准的 8px 内边距和 5px 行圆角，Config 基准的 4px 行间距。弹层内层滚动容器 `.app-menu-list` 不额外增加 padding；不得为 Config、推理或模型各自叠加一层边距。`e2e/option-controls.mjs` 测量真实设置页与各类弹层的选项边界，而非仅检查 CSS 声明。

同步桌面上游时遵循 [同步流程](../fork-sync.zh-CN.md)。统一选项菜单、4px 行间距、
独立 Config 入口、发送按钮与输入框底部圆角同心、顶部操作靠右，以及运行时 home
解析必须保留；拆出的上游组件要接入这些规则，不能用旧组件替换上游功能。

## 输入框单按钮与待发送队列

- 输入框只保留一个圆形主操作：空闲时发送；运行中且草稿为空时停止（方块）；运行中有文字或附件时，点击或发送快捷键都加入“完成后发送”队列。不要重新引入 Steer / Follow-up 双按钮或底栏重复的 Stop。
- `ComposerOutbox` 把待发送消息贴在输入框上沿；每条消息支持立即发送、取回编辑、删除。窄窗口操作使用图标和完整无障碍标签，触屏点击范围至少 44px；不使用彩色描边区分队列模式。
- 立即发送通过 SDK prompt admission 的 `steer` 在下一个可接收指令的时机引导当前任务，不承诺强制中断正在进行的工具调用。编辑通过 `restoreSubmission` 合并到原会话草稿，保留已有输入与图片。
- 验证：`node e2e/composer-outbox.mjs`，覆盖深浅色、1280/390/320 宽度、换行同心圆角、排队/编辑/删除/引导、页面刷新及停止后的队列状态。


## 外观与背景

外观页的 `FontSettings` 分别选择界面与代码字体；常用字体通过共享 `AppSelect` 选择，
自定义名称显式应用，恢复默认时移除界面设置的覆盖，让原有 `custom.css` 重新接管。
`useFonts` 在 AppShell 生命周期中恢复配置、即时应用并串行保存到
`pi-web/settings.json` 的 `fonts`，旧读取不能覆盖新选择；失败保留本地预览并提供重试。
`FONT_INIT_SCRIPT` 只从本地缓存恢复首屏，服务器选择负责跨端口恢复。
界面字体同时覆盖标题，代码字体更新已有 xterm 的字体与尺寸，不重建终端会话。
默认字体栈保留上游的原生等宽字体优先级和中文回退；通过 `--font-*-default`
接入字体选择器，恢复默认时同时恢复上游的字体顺序。
字体名称为单个本机 family，不下载字体，不改写用户样式表。
桌面外观页通过 `listInstalledFontsNative()` 和受桌面进程 token 保护的 `/api/desktop/fonts`
读取本机字体；Windows 使用系统字体集合及其本地化名称，macOS 使用 system_profiler，Linux 使用 fontconfig。
两种字体选择器沿用 AppSelect 的菜单、键盘导航和间距，读取失败保留手动输入并提供重试。
字体为默认值时隐藏恢复按钮，改动后显示可用的恢复操作；标题行保留高度。
字体保存状态仅供读屏播报，不插入可见行挤动布局；错误仍显示并可重试。
嵌入设置的配置面板与侧栏共用 `--surface-elevated`，与常规/外观内容底色一致，控件和选中态仍使用各自 token。
设置行的 `.settings-option-action` 使用 `align-self: center`，与多行说明整体居中。
终端说明与 Shell 工具一致，使用标题与选项之间的 `.settings-general-description`，不放进选项卡片。
回归：`node e2e/fonts.mjs` 覆盖真实设置页、即时预览、保存/恢复、错误、菜单及按钮几何。

外观页只提供明暗模式，没有背景选择；侧栏、窗口和设置外框是同一个中性纯色（`--canvas-background`），
强调色用 CSS `AccentColor` 跟随系统。`THEME_INIT_SCRIPT` 先使用浏览器缓存避免刷新闪烁。相关回归：`node e2e/appearance.mjs`。

## 设置选项细节

`ConfigSidebarList` 与 `.config-sidebar-group` 都按共享 `--choice-*` 留距；模型供应商的
子项容器同样使用 `.config-sidebar-group`，不能重新引入零间距或行内 margin。
分段控件共用 `--segment-*`，内衬和按钮间隔都引用设置行间距的 4px（5px 内圆角、9px 外圆角），涵盖明暗、语言、
发送快捷键、Diff 和作用域。选中状态在鼠标悬停自身或相邻项时必须保持；键盘焦点与禁用语义保留。
文件与 Artifact 的预览／源码切换也使用这套分段控件参数，工具定义列表同样保持 4px 行间距。
`node e2e/settings-controls.mjs` 测量真实设置组件，不只断言 CSS 字符串。

输入框加号沿第一行文字居中；SVG、占位文字和实际文字用同一行高计算。加号不是字符，
不能用字形基线偏移来补偿；多行仍保留右下发送按钮的同心几何。几何回归覆盖全部字号范围。
