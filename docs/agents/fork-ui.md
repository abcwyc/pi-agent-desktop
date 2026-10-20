# Layout, settings and client behavior — fork notes

Fork-owned notes moved out of `AGENTS.md` to keep it short. The upstream doc on the same topic (`docs/agents/*.md` without the `fork-` prefix) may describe the same area in other words; where they disagree, these notes describe this fork. Hard rules that must survive a merge are also listed in `AGENTS.md` under **Hard rules**.

## Touch affordances
Session rows render the "…" action menu when `(hovered || touchMode)` — `touchMode` is a post-mount `matchMedia("(hover: none)")` check, so hover styling is untouched on desktop and rename/delete stay reachable on touch. The composer's single circular action shows Stop while a run is active and the draft is empty; typing switches it to queued Send, including on narrow screens. Escape remains available to stop while drafting. Rename/delete failures use the global shell notice shelf (`appNotify.error` with `sidebar.renameFailed` / `sidebar.deleteFailed`) instead of being swallowed.
Message-row copy/edit/fork actions use CSS hover/focus-within reveal instead of JS hover state, and are always visible under `(hover: none)`. They must remain pointer-enabled when focused so keyboard tabbing does not land on invisible controls.
While a session runs, in-session "Edit from here" stays visible but disabled with the Esc hint; fork stays available because it copies to an independent file.

## Global operation notices
`lib/notification-store.ts` and `components/AppNoticeShelf.tsx` own cross-surface shell notices (`appNotify.info/success/warning/error`). They queue and expire automatically, but a notice with an action stays until dismissed so the action cannot vanish. Keep errors beside the affected control when position carries meaning; use the shelf when the action comes from a global surface such as the sidebar or workspace shell. Do not claim Undo in one of these notices unless the data path really restores the original state — session DELETE currently unlinks files and cascades subagents, so it has no safe client-side undo.

## Keyboard shortcuts
`hooks/useKeyboardShortcuts.ts` owns app-level shortcuts. Cmd/Ctrl+\ closes the right workspace (never bare `\`), Cmd/Ctrl+/ opens the shortcut reference dialog, Cmd/Ctrl+B toggles the sidebar, and Cmd/Ctrl+L focuses the composer. Browser-reserved variants may not fire in the web build; the desktop shell receives them. Help must not layer over Settings or let another global shortcut fire through it: pass the other callbacks as `undefined` while it is open, then focus the dialog, capture Escape (so closing it does not also stop a run), and keep Tab inside the dialog.
The sidebar project tree is a keyboard `tree`: rows move focus with Up/Down/Home/End, project and subagent groups expand/collapse with Right/Left, Enter/Space activates, F2 starts rename, and Delete arms the same inline confirmation as the row menu. Roving-tabindex extraction is intentionally not used yet because timeline rows and future non-session tree rows still need one shared focus model.

## Projects pane views
The Projects header's hover-only `…` menu switches between `grouped` (project rows with nested session families) and `timeline` (all top-level session families sorted by the root session's `modified` time, with each row's project name after the title). The choice persists in `APP_PREF_KEYS.projectViewMode`. Collapse/expand-all remain grouped-view actions; switching modes never rewrites the stored `collapsedProjects` set. The old Recent section is intentionally gone — the timeline replaces it. Desktop uses `showNativeMenu` check items, while the web build renders `ProjectViewMenu` as a DOM popover. In grouped view, "Show more" reveals five additional session rows per click; collapsing and reopening a project clears that page state so it starts from the latest five (`APP_PREF_KEYS.expandedProjects` stores root → extra pages).

## Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

## Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`. The switch is in Settings › General (`settings.completionSound`), not the composer row.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

## Settings dialog: one tab per concern
- The sidebar gear opens Settings directly through `openSettingsAtLastSection`, the same entry used by the keyboard shortcut. First use opens General; subsequent visits restore the last available section. Category navigation lives inside Settings; do not restore an intermediate section menu.
- The settings dialog's tabs are exactly `general`, `models`, `skills`, `agents`, `plugins` (`SETTINGS_SECTION_VALUES`). The former `desktop` tab duplicated General's language and theme pickers, so it was removed: the product blurb and Version & Updates sit at the top of General, the custom-stylesheet and diff-display controls joined General's appearance/chat sections, and the desktop window/tray switches live in `components/desktop/DesktopAppSection.tsx`, which renders nothing in a browser (same self-hiding contract as `WindowControls`). `components/AppUpdatesSection.tsx` owns the update check and its chips.
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
