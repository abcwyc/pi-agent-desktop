import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("only Shift+click bypasses session deletion confirmation", () => {
  // Deleting without Shift must always route through the confirmation step.
  // The handler moved inline into the row's menu item, so match the guard
  // itself rather than a named function, and tolerate either brace style.
  assert.match(
    sessionItemSource,
    /if \(e\.shiftKey\)\s*\{?\s*void performDelete\(\);\s*\}?\s*else\s*\{?\s*setConfirmDelete\(true\);/,
  );
});

test("keeps the project-tree sidebar without an inline explorer section", () => {
  // Upstream's resizable sidebar explorer (ed50d88) is deliberately not
  // adopted: this fork renders the file explorer in the right panel and the
  // sidebar as Chats + project lists. The upstream quick-filter stays.
  assert.match(source, /sidebar-search-input/);
  assert.match(source, /sidebar-chats-header/);
  assert.doesNotMatch(source, /data-resize-handle="sidebar-sections"/);
});

test("the sidebar tree supports row-level keyboard navigation", () => {
  assert.match(source, /role="tree"/);
  assert.match(source, /data-sidebar-tree-row/);
  assert.match(source, /case "ArrowDown":[\s\S]*?focusSidebarTreeRow\(current, 1\)/);
  assert.match(source, /case "ArrowUp":[\s\S]*?focusSidebarTreeRow\(current, -1\)/);
  assert.match(source, /case "Home":[\s\S]*?focusSidebarTreeRow\(current, "first"\)/);
  assert.match(source, /case "End":[\s\S]*?focusSidebarTreeRow\(current, "last"\)/);
  assert.match(sessionItemSource, /role="treeitem"/);
  assert.match(sessionItemSource, /aria-selected=\{isSelected\}/);
  assert.match(sessionItemSource, /requestDelete: beginDeleteConfirmation/);
  assert.match(sessionItemSource, /rename: startRename/);
});

test("streams running sessions and reconnects after visibility or network changes", () => {
  assert.match(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisible\)/);
  assert.match(source, /window\.addEventListener\("online", connect\)/);
  assert.match(source, /source\?\.close\(\)/);
});

test("re-adding a removed project clears only its sidebar marker", () => {
  assert.match(source, /const activateProject = useCallback\(\(cwd: string\) =>/);
  assert.match(source, /if \(!previous\.has\(projectRoot\)\) return previous;/);
  assert.match(source, /next\.delete\(projectRoot\);/);
  // The add-project dialog is the only picker left in the sidebar.
  assert.match(source, /onSelectCwd=\{\(cwd\) => \{\s+activateProject\(cwd\);/);
});

test("exposes the polled running-session set to the shell", () => {
  assert.match(source, /onRunningSessionIdsChange\?: \(ids: Set<string>\) => void/);
  assert.match(source, /onRunningSessionIdsChange\?\.\(runningSessionIds\)/);
});

test("exposes the loaded session catalog to the shell", () => {
  assert.match(source, /onSessionsChange\?: \(sessions: SessionInfo\[\]\) => void/);
  assert.match(source, /onSessionsChange\?\.\(allSessions\)/);
});

test("subagent completion stays silent and never becomes unread", () => {
  assert.match(source, /completionNotificationSuppressedSessionIds\?: string\[\]/);
  assert.match(
    source,
    /completedWithNotifications = completedInBackground\.filter\([\s\S]*?!previousSuppressedCompletionSessionIdsRef\.current\.has\(id\)[\s\S]*?!knownSubagentIds\.has\(id\)/,
  );
  assert.match(source, /completedWithNotifications\.forEach\(\(id\) => next\.add\(id\)\)/);
  assert.match(source, /if \(completedWithNotifications\.length > 0\) \{\s*onBackgroundTaskDone\?\.\(\)/);
  assert.match(
    source,
    /filter\(\(session\) => session\.relation\?\.kind !== "subagent"\)[\s\S]*?unreadEligibleIds\.has\(id\)/,
  );
});

test("includes project activity counts in accessible labels", () => {
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.agentRunning"\)\} \(\$\{activity\.running\}\)`\}/,
  );
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.newSessionActivity"\)\} \(\$\{activity\.unread\}\)`\}/,
  );
});

test("formats session timestamps with the active locale", () => {
  assert.match(source, /import \{ formatCompactRelativeTime, formatRelativeTime \} from "@\/lib\/i18n\/format"/);
  assert.match(sessionItemSource, /const \{ locale, t \} = useI18n\(\)/);
  assert.match(sessionItemSource, /formatRelativeTime\(session\.modified, locale\)/);
});

test("does not persist an unchanged fallback title ending in whitespace", () => {
  assert.match(
    sessionItemSource,
    /const name = renameValue\.trim\(\);[\s\S]*?if \(renameValue === title \|\| name === \(session\.name \?\? ""\)\) return;/,
  );
});

test("offers the downstream context-menu hook only on a normal session row", () => {
  assert.match(sessionItemSource, /const handleContextMenu[\s\S]*?dispatchSessionRowContextMenu\(\{/);
  assert.match(
    sessionItemSource,
    /onContextMenu=\{confirmDelete \|\| renaming \? undefined : handleContextMenu\}/,
  );
});

test("lifecycle refreshes bypass the cache while cross-window polling reuses it", () => {
  assert.match(source, /function sessionListUrl\(summary: boolean, force: boolean\)/);
  assert.match(source, /if \(summary\) return "\/api\/sessions\?summary=1"/);
  assert.match(source, /if \(force\) return "\/api\/sessions\?force=1"/);
  assert.match(source, /cache: "no-store"/);
  // First paint uses the cheap summary listing, then hydrates after a delay.
  assert.match(source, /loadSessions\(true, false, true\)/);
  assert.match(source, /setTimeout\(\(\) => \{[\s\S]*?void loadSessions\(false, true\)/);
  assert.match(source, /data\.sessionListVersion !== sessionListVersionRef\.current[\s\S]*?await loadSessions\(\)/);
  assert.doesNotMatch(source, /sessionRefreshDone|sessionRefreshTimerRef|title=\{t\("sidebar\.refresh"\)\}/);
  assert.match(source, /loadSessions\(false, true\);[\s\S]*?onBackgroundTaskDone/);
});

test("does not expose disk-backed actions for transient sessions", () => {
  assert.match(sessionItemSource, /if \(session\.transient\) return;/);
  assert.match(sessionItemSource, /\{!session\.transient && \(\s*<div\s+className="session-item-trailing"/);
});

test("hides subagent rows and aggregates their state into the main session row", () => {
  assert.match(source, /const sessionFamilies = listSessionFamilies\(projectSessions\)/);
  assert.match(source, /familySessions\.some\(\(session\) => session\.id === selectedSessionId\)/);
  assert.match(source, /familySessions\.some\(\(session\) => runningSessionIds\.has\(session\.id\)\)/);
  assert.doesNotMatch(source, /function SessionTreeItem/);
});

test("Chats sit beside Projects and never enter project grouping", () => {
  assert.match(
    source,
    /const chatSessions = filteredSessions[\s\S]*?session\.workspaceKind === "chat" \|\| isChatCwd\(session\.cwd\)[\s\S]*?const projectSessions = filteredSessions\.filter\(/,
  );
  assert.match(source, /const chatFamilies = listSessionFamilies\(chatSessions\)/);
  assert.match(source, /const sessionFamilies = listSessionFamilies\(projectSessions\)/);
  assert.match(source, /groupByProject\(projectSessions,/);
  assert.match(source, /getRecentProjects\(allSessions\)/);
  assert.match(source, /<div className="sidebar-project-tree-header sidebar-chats-header">/);
  assert.match(source, /handleNewSession\(chatWorkspaceCwd \?\? undefined, "chat"\)/);
});

test("Chats show five families at a time even when there are no projects", () => {
  assert.match(source, /const MAX_VISIBLE_CHAT_SESSIONS = 5/);
  assert.match(source, /: chatFamilies\.slice\(0, chatVisibleCount\)/);
  assert.match(source, /setChatVisibleCount\(\(count\) => count \+ MAX_VISIBLE_CHAT_SESSIONS\)/);
  assert.match(source, /!loading && !error && chatFamilies\.length === 0/);
  assert.match(source, /sidebar-chats-empty/);
  // The Chats section renders before the Projects empty state, so it remains
  // available when `activeProjects` is empty.
  assert.match(
    source,
    /sidebar-chats-header[\s\S]*?\{allProjects\.length === 0 \? \(/,
  );
});

test("a chat cwd skips worktree lookup and stays out of project pickers", () => {
  assert.match(source, /if \(!selectedCwd \|\| selectedCwdIsChat\) \{\s*setWorktreeState\(null\)/);
  assert.match(source, /const selectedProjectRoot = selectedProjectObject\?\.kind === "project"/);
  assert.match(source, /selectedCwd=\{selectedCwdProp && !isChatCwd\(selectedCwdProp\) \? selectedCwdProp : null\}/);
  assert.match(source, /if \(isChatCwd\(cwd\)\) return projectSelection\(cwd, cwd, "chat"\)/);
});

test("the project context menu reveals the project in the OS file manager", async () => {
  // Upstream's open-in-file-manager (#907) reaches the fork through the
  // project context menu: the desktop shell reveals natively and the browser
  // goes through /api/open-in-explorer, which the menu only offers after the
  // availability probe answered. A failure stays visible inside the menu.
  assert.match(source, /const revealProjectInFileManager = useCallback/);
  assert.match(source, /isTauriDesktop\(\) \|\| fileManagerAvailability\?\.supported/);
  assert.match(source, /revealItemInDirNative\(root\)/);
  assert.match(source, /fetch\("\/api\/open-in-explorer", \{\s*method: "POST"/);
  assert.match(source, /FILE_MANAGER_ERROR_KEYS\[data\.error \?\? ""\]/);
  // The menu itself is fork-owned (components/ProjectContextMenu.tsx).
  const menuSource = await readFile(new URL("./ProjectContextMenu.tsx", import.meta.url), "utf8");
  assert.match(menuSource, /\{projectRevealError && \(/);
  // The platform-adaptive label (Finder / Explorer / generic).
  assert.match(source, /"sidebar\.openInFinder"/);
  assert.match(source, /"sidebar\.openInExplorer"/);
  assert.match(source, /"sidebar\.openInFileManager"/);
});

test("session rows swap a compact time for the action button in one fixed-width slot", () => {
  // At rest the row shows its last-activity time; hover, keyboard focus,
  // touch and an open menu show the "…" button in the same slot so the title
  // never reflows.
  assert.match(sessionItemSource, /className="session-item-trailing"/);
  assert.match(sessionItemSource, /hovered \|\| treeFocused \|\| touchMode \|\| menuOpen \?/);
  assert.match(sessionItemSource, /formatCompactRelativeTime\(session\.modified, locale\)/);
  // Transient runtime rows have neither actions nor a reliable time.
  assert.match(sessionItemSource, /\{!session\.transient && \(\s*<div\s+className="session-item-trailing"/);
});

test("project header shows a session count and chips only while folded", () => {
  // A folded project hides its rows, so the header carries the count.
  assert.match(source, /\{isCollapsed && \(\s*<span className="sidebar-project-tree-count"[^>]*>\s*\(\{groupTree\.length\}\)/);
  assert.match(source, /\{isCollapsed && \(\s*<span className="sidebar-project-tree-meta">/);
  // The branch moved from the row into its tooltip.
  assert.doesNotMatch(source, /className="sidebar-project-tree-branch"/);
  assert.match(source, /title=\{rowTitle\}/);
});

test("project header keeps its actions hover-only and no separate chevron", async () => {
  const css = (await readFile(new URL("../app/native-theme.css", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  // The folder glyph already shows open / closed; a chevron would repeat it.
  assert.doesNotMatch(source, /sidebar-project-tree-chevron/);
  assert.match(source, /aria-expanded=\{!isCollapsed\}/);
  assert.match(css, /\.sidebar-project-tree-row-actions \{[^}]*opacity: 0;[^}]*pointer-events: none;/);
  assert.match(css, /\.sidebar-project-tree-row\.is-menu-open \.sidebar-project-tree-row-actions/);
  assert.match(css, /@media \(hover: none\) \{[^@]*\.sidebar-project-tree-row-actions \{\s*opacity: 1;/);
});

test("Projects header actions stay hover-only", async () => {
  const css = await readFile(new URL("../app/native-theme.css", import.meta.url), "utf8");
  assert.match(css, /\.sidebar-project-tree-tools \{[^}]*opacity: 0;[^}]*pointer-events: none;/);
  assert.match(css, /\.sidebar-project-tree-header:hover \.sidebar-project-tree-tools,/);
  assert.match(css, /\.sidebar-project-tree-header\.is-menu-open \.sidebar-project-tree-tools,/);
  assert.match(css, /\.sidebar-project-tree-header:focus-within \.sidebar-project-tree-tools \{\s*opacity: 1;\s*pointer-events: auto;/);
  assert.match(css, /@media \(hover: none\) \{[^@]*\.sidebar-project-tree-tools \{\s*opacity: 1;\s*pointer-events: auto;/);
});

test("folded projects persist across reloads", () => {
  assert.match(source, /getPrefJson<unknown>\(APP_PREF_KEYS\.collapsedProjects\)/);
  assert.match(source, /setPrefJson\(APP_PREF_KEYS\.collapsedProjects, \[\.\.\.collapsedProjects\]\)/);
  // Collapse/expand-all operate on the visible project groups.
  assert.match(source, /const canCollapseAllProjects = activeProjects\.some\(\(group\) => !collapsedProjects\.has\(group\.projectRoot\)\)/);
  assert.match(source, /const canExpandAllProjects = activeProjects\.some\(\(group\) => collapsedProjects\.has\(group\.projectRoot\)\)/);
  assert.match(source, /setCollapsedProjects\(new Set\(activeProjectRoots\)\)/);
  assert.match(source, /setCollapsedProjects\(new Set\(\)\)/);
});

test("show more reveals five sessions at a time and a project toggle resets it", () => {
  assert.match(source, /getPrefJson<unknown>\(APP_PREF_KEYS\.expandedProjects\)/);
  assert.match(source, /setPrefJson\(APP_PREF_KEYS\.expandedProjects, projectSessionPages\)/);
  assert.match(source, /const visibleSessionLimit = MAX_VISIBLE_PROJECT_SESSIONS \* \(extraPages \+ 1\)/);
  assert.match(
    source,
    /\[group\.projectRoot\]: \(prev\[group\.projectRoot\] \?\? 0\) \+ 1/,
  );
  assert.match(
    source,
    /count: Math\.min\(MAX_VISIBLE_PROJECT_SESSIONS, hiddenSessionCount\)/,
  );
  // Reopening a project starts from its latest five sessions again.
  assert.match(source, /setProjectSessionPages\(\(prev\) => \{[\s\S]*?delete next\[group\.projectRoot\]/);
  // Legacy arrays meant "expanded everything"; migrate them to one extra page.
  assert.match(source, /Array\.isArray\(stored\)[\s\S]*?\.map\(\(root\) => \[root, 1\]\)/);
});

test("Projects pane chooses between grouped and chronological views", () => {
  // The old Recent section is replaced by a persisted display mode.
  assert.doesNotMatch(source, /recent-sessions|sidebar-recent-section|hasTodaySessions|recentSessions/);
  assert.match(source, /const \[projectViewMode, setProjectViewMode\] = useState<ProjectViewMode>\(loadProjectViewMode\)/);
  assert.match(source, /setPref\(APP_PREF_KEYS\.projectViewMode, mode\)/);
  assert.match(
    source,
    /projectViewMode === "timeline"\s*\? renderTimeline\(\)\s*: activeProjects\.map\(\(group\) => renderProjectGroup\(group\)\)/,
  );
});

test("the chronological view lists session families by activity with project labels", () => {
  assert.match(source, /const timelineFamilies = projectViewMode === "timeline"/);
  assert.match(source, /sessionFamilies\.filter\(\(family\) =>/);
  assert.match(source, /\.sort\(\(a, b\) => b\.root\.modified\.localeCompare\(a\.root\.modified\)\)/);
  assert.match(source, /buildSessionTree\(\[family\.root, \.\.\.family\.subagents\]\)/);
  assert.match(source, /className="sidebar-project-timeline"/);
  assert.match(source, /subtitle=\{projectName\}/);
});

test("the Projects menu keeps grouped/timeline choices and collapse controls", async () => {
  const menuSource = await readFile(new URL("./ProjectViewMenu.tsx", import.meta.url), "utf8");
  assert.match(menuSource, /role="menuitemradio"/);
  assert.match(menuSource, /sidebar\.projectViewGrouped/);
  assert.match(menuSource, /sidebar\.projectViewTimeline/);
  assert.match(menuSource, /sidebar\.collapseAllProjects/);
  assert.match(menuSource, /sidebar\.expandAllProjects/);
  assert.match(source, /canUseNativeMenu\(\)[\s\S]*?showNativeMenu\(entries, menuPointBelow\(anchor, "right"\)\)/);
});

test("the row menu shows the compaction count only when the session was compacted", () => {
  assert.match(
    sessionItemSource,
    /\{\(session\.compactionCount \?\? 0\) > 0 && \(\s*<div>\{t\("sidebar\.compactionCount", \{ count: session\.compactionCount \?\? 0 \}\)\}<\/div>/,
  );
});
