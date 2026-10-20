/**
 * Sentinels for fork changes inside upstream-owned components.
 *
 * A `git merge` conflict from agegr/pi-web is the safe outcome: the sync job
 * fails and a human looks. These tests cover the unsafe outcome — a merge that
 * succeeds cleanly and is still wrong, in either direction:
 *
 *   RESURRECTION  Code the fork moved to another file reappears at its origin.
 *                 Git does not track cross-file moves, so an upstream edit to
 *                 the moved region merges straight back in and the app ends up
 *                 with two copies of the same behaviour.
 *
 *   EROSION       A fork change is dropped by the merge, silently reverting a
 *                 desktop feature to its upstream form.
 *
 *   RE-ADOPTION   A region the fork deliberately deleted comes back, because
 *                 upstream still ships it and the deletion lost the conflict.
 *                 Covered by a FORK_FEATURES entry's `forbiddenMarkers`.
 *
 * Neither shows up in tsc, eslint, or the upstream test suite. See
 * docs/ownership-boundaries.md; risk levels live in scripts/fork-ownership.json.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (file) => readFile(join(rootDir, file), "utf8");

/** Source with import statements removed, so a re-import never reads as a definition. */
function withoutImports(source) {
  return source.replace(/^import\s[\s\S]*?from\s+["'][^"']+["'];?$/gm, "");
}

function definesSymbol(source, symbol) {
  const body = withoutImports(source);
  return new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?(?:function|class|const|let|var)\\s+${symbol}\\b`,
  ).test(body);
}

const EXTRACTIONS = [
  {
    name: "i18n fork message patch",
    origin: "lib/i18n/registry.ts",
    // Upstream message packs are intentionally held in upstream shape. The
    // fork's additions, replacements, and deletions live in a fork-owned patch
    // module so upstream key edits merge directly into the three message files.
    movedTo: ["lib/i18n/locale-plugins.ts"],
    movedDefinitions: ["FORK_MESSAGE_PATCHES", "withForkMessages", "forkLocalePlugins"],
    absentFromOrigin: ["enLocale, zhCNLocale, zhTWLocale"],
    presentInTargets: ["./messages/en.ts"],
    requiredInOrigin: ["forkLocalePlugins"],
  },
  {
    name: "SessionSidebar project picker",
    origin: "components/SessionSidebar.tsx",
    // Roughly 500 lines were moved out of SessionSidebar into these files,
    // neither of which exists upstream. This is the highest-risk divergence in
    // the fork; see the manifest entry for components/SessionSidebar.tsx.
    movedTo: ["components/ProjectPicker.tsx", "components/path-ui.tsx"],
    movedDefinitions: ["getRecentProjects", "displayCwd", "PathLabel", "AnimatedDropdown"],
    // Project-picker internals that must live only in ProjectPicker now.
    absentFromOrigin: [
      "customPathOpen",
      "customPathValidating",
      "projectFilter",
      "/api/cwd/validate",
      "/api/default-cwd",
    ],
    requiredInOrigin: ["ProjectPicker"],
  },
  {
    name: "AppShell window chrome",
    origin: "components/AppShell.tsx",
    // Desktop-only UI belongs in components/desktop/, so upstream layout files
    // carry a mount point rather than Tauri calls and window state.
    movedTo: ["components/desktop/WindowControls.tsx", "components/desktop/useDesktopChrome.ts"],
    movedDefinitions: [],
    absentFromOrigin: [
      "minimizeWindow",
      "toggleMaximizeWindow",
      "closeWindow",
      "isWindowMaximized",
      "window-control-btn",
      "@/lib/desktop-window",
    ],
    requiredInOrigin: ["WindowControls", "useDesktopChrome"],
  },
  {
    name: "app info panel folded into General settings",
    origin: "components/SettingsPanel.tsx",
    // The Version & Updates block and the desktop window/tray switches used to
    // live in a standalone AppSettings modal reachable as a second settings tab
    // whose language and theme pickers duplicated General. They moved to
    // fork-owned files; regrouping them back into the settings panel is the
    // resurrection this guards against.
    movedTo: ["components/AppUpdatesSection.tsx", "components/desktop/DesktopAppSection.tsx"],
    movedDefinitions: ["AppUpdatesSection", "DesktopAppSection"],
    absentFromOrigin: ["/api/updates", "installLatestDesktopRelease", "closeQuits", "quitAppNative"],
    requiredInOrigin: ["AppUpdatesSection", "DesktopAppSection"],
  },
  {
    name: "useAgentSession fork layers",
    origin: "hooks/useAgentSession.ts",
    // useAgentSession is upstream's and the fork's biggest hook. The features the
    // fork added on top (summarized branch switches, the 0.86 automation switches,
    // compaction no-op notices, dismissible scope warnings, the extra SDK events)
    // live in fork-owned hooks it calls; upstream's own code — the event-stream
    // lifecycle, running-state reconciliation, the guards AGENTS.md lists — stays
    // in the origin so upstream edits to it still merge in place.
    movedTo: [
      "hooks/useBranchSummary.ts",
      "hooks/useSessionAutomation.ts",
      "hooks/useCompactNotice.ts",
      "hooks/useScopeWarningDismissal.ts",
      "hooks/useForkAgentEvents.ts",
    ],
    movedDefinitions: [
      "branchSummaryHolds",
      "summarizeAndNavigate",
      "handleAbortBranchSummary",
      "handleSetAutomation",
      "handleAbortRetry",
      "compactNoopMessage",
      "reportCompactFailure",
      "dismissModelScopeWarnings",
      "visibleModelScopeWarnings",
      "PENDING_BASH_OUTPUT_CAP",
      "externalAppendRefreshAtRef",
    ],
    absentFromOrigin: [
      "abort_branch_summary",
      "abort_retry",
      "set_steering_mode",
      "set_follow_up_mode",
      'case "summarization_retry_scheduled"',
      'case "bash_execution_update"',
      'case "entry_appended"',
      'case "session_replaced"',
      "setDismissedScopeWarningKeys",
    ],
    requiredInOrigin: [
      "useBranchSummary(",
      "useSessionAutomation(",
      "useSessionAutomationActions<",
      "useCompactNotice(",
      "useScopeWarningDismissal(",
      "useForkAgentEvents(",
      "handleForkAgentEvent(event)",
    ],
  },
  {
    name: "ChatInput fork layers",
    origin: "components/ChatInput.tsx",
    // The composer is upstream's. The fork's `#` session mentions, session (gear)
    // menu and project chip live in fork-owned files; ChatInput keeps their state
    // where its shared keyboard and outside-click handlers need it, and mounts them.
    movedTo: [
      "hooks/useSessionMentionPalette.ts",
      "components/SessionMentionMenu.tsx",
      "components/SessionAutomationMenu.tsx",
      "components/ComposerProjectChip.tsx",
    ],
    movedDefinitions: ["getProjectLabel", "applyHashCompletion", "updateHashQuery", "hashMatches"],
    absentFromOrigin: [
      "sessionIndexFetchingRef",
      "chat.noMatchingSessions",
      "chat.autoCompaction",
      "chat.steeringMode",
      "chat-project-context",
      "chat.switchProject",
    ],
    requiredInOrigin: [
      "useSessionMentionPalette(",
      "<SessionMentionMenu",
      "<SessionAutomationMenu",
      "<ComposerProjectChip",
    ],
  },
  {
    name: "AppShell fork layers",
    origin: "components/AppShell.tsx",
    // Desktop cold-start tab restore and the missing-workspace probe stay in hooks.
    movedTo: [
      "hooks/useDesktopWorkspaceTabs.ts",
      "hooks/useWorkspaceAvailability.ts",
    ],
    movedDefinitions: ["workspaceStatusRef"],
    absentFromOrigin: [
      "workspaceFileTabsMatchContext",
      "setWorkspaceHydrated",
      "/api/cwd/status",
    ],
    requiredInOrigin: [
      "useDesktopWorkspaceTabs(",
      "useWorkspaceAvailability(",
    ],
  },
  {
    name: "SessionSidebar project menu",
    origin: "components/SessionSidebar.tsx",
    // The project row's "…" menu (DOM and native) — branches with fetch, and
    // the worktree pages that replaced the hidden header dropdown — is a fork
    // feature; the sidebar keeps the menu state and wires the actions in.
    // Reveal-in-file-manager stays in the origin: it is upstream's (#907).
    movedTo: ["components/ProjectContextMenu.tsx", "hooks/useProjectWorktreeActions.ts"],
    movedDefinitions: [
      "fetchProjectBranchMenu",
      "showNativeProjectBranchMenu",
      "showNativeProjectWorktreeMenu",
      "createProjectWorktree",
      "removeProjectWorktree",
      "fetchRemoteBranches",
    ],
    absentFromOrigin: [
      "sidebar-project-context-menu",
      "sidebar.fetchBranchesTitle",
      "sidebar.branchInWorktreeTitle",
      "sidebar.confirmRemoveWorktree",
      "/api/worktrees/fetch",
    ],
    requiredInOrigin: [
      "<ProjectContextMenu",
      "showNativeProjectBranchMenu(",
      "showNativeProjectWorktreeMenu(",
      "useProjectWorktreeActions(",
    ],
  },
  {
    name: "rpc-manager session replacement",
    origin: "lib/rpc-manager.ts",
    // Forking a session file and an extension command's ctx.newSession / fork /
    // switchSession are fork features; AgentSessionWrapper only wires them in.
    movedTo: ["lib/session-replacement.ts"],
    movedDefinitions: ["UNSAVED_SESSION_FORK_ERROR", "createSessionReplacementActions"],
    absentFromOrigin: [
      "cancelledBySessionReplacementHook",
      "moveToReplacementSession",
      "session_before_fork",
      "Session file not found: ",
    ],
    requiredInOrigin: ["createSessionReplacementActions(", "writeForkedSession(this.inner"],
  },
];

const FORK_FEATURES = [
  {
    name: "ChatWindow new-session header",
    file: "components/ChatWindow.tsx",
    // Upstream renders an empty-state branding header (app icon + product name +
    // version badge) directly above the composer. The fork strips it, and later
    // dropped the update chip that replaced it, so merging upstream's
    // ChatWindow.tsx would silently put the header back — the absence checks
    // are the point of this entry.
    markers: ["isEmptyNew"],
    forbiddenMarkers: ["apple-touch-icon", "PRODUCT_NAME", "NewSessionUpdateLink"],
  },
  {
    name: "sidebar header controls",
    file: "components/AppShell.tsx",
    // The top-right row of the sidebar is settings + collapse only. The sun/moon
    // theme toggle that used to sit beside them (upstream's "toolbar theme
    // selector", reachable here through the fork's restyle) was removed on
    // request; theme selection lives in Settings → General, and its locale keys
    // (`theme.light` / `theme.dark` / …) went with it.
    markers: ["onClick={openSettingsAtLastSection}", "sidebar-chrome-button", "handleSidebarToggle"],
    forbiddenMarkers: ["theme.light", "aria-pressed={isDark}"],
  },
  {
    name: "AppShell desktop chrome",
    file: "components/AppShell.tsx",
    // The window buttons and platform detection live in components/desktop/ now;
    // what AppShell must keep is the mount point and the drag-region spread.
    markers: [
      "useDesktopChrome",
      "WindowControls",
      "dragRegionProps",
      "app-topbar--mac-inset",
      "SettingsPanel",
      "UpdateReminder",
      "PRODUCT_NAME",
    ],
  },
  {
    name: "app info and desktop preferences live in General settings",
    file: "components/SettingsPanel.tsx",
    markers: ["AppUpdatesSection", "DesktopAppSection", "settings-general-intro"],
  },
  {
    name: "FileViewer toolbar",
    file: "components/FileViewer.tsx",
    markers: ["FileViewerToolbar", "getFileIcon", "file-viewer-toolbar"],
  },
  {
    name: "TabBar chrome",
    file: "components/TabBar.tsx",
    markers: ["file-tab-bar", "file-tab-label", "file-tab-close"],
  },
  {
    name: "Scheduled entry in the sidebar",
    file: "components/SessionSidebar.tsx",
    // The row under New Session, and the filter that keeps scheduled runs out of the
    // project tree. Losing the filter would bury a user's own sessions under every
    // run of an hourly task; losing the row leaves the feature unreachable.
    // The completion notification skips scheduled sessions: they report through
    // useScheduledRunNotifications instead, so losing the guard doubles every notification.
    markers: ["ScheduledSidebarRow", "onOpenScheduled", 'relation?.kind !== "scheduled"', "isScheduledRunSession"],
  },
  {
    name: "Scheduled page in AppShell",
    file: "components/AppShell.tsx",
    // The page covers the chat without unmounting it. Picking a session or starting a
    // new one must close it, and the cold-start restore must not.
    markers: ["ScheduledView", "scheduledOpen", "scheduledOpenRef", "handleOpenScheduled", "setScheduledOpen(false)", "useScheduledRunNotifications"],
  },
  {
    name: "scheduled runs are tagged in the session list",
    file: "app/api/sessions/route.ts",
    markers: ["attachScheduledRelations"],
  },
  {
    name: "scheduler starts with the server",
    file: "instrumentation-node.ts",
    markers: ["startScheduler"],
  },
  {
    name: "native theme layer",
    file: "app/layout.tsx",
    // Dropping this import silently reverts the entire restyle to upstream.
    markers: ["./native-theme.css", "PRODUCT_NAME"],
  },
  {
    name: "artifacts: assistant markdown renders previews and artifact cards",
    file: "components/MarkdownBody.tsx",
    // Inline ```html/```svg/```jsx previews and `:::artifact` cards. All the logic
    // lives in lib/html-preview.ts, lib/artifacts.ts and the Artifact*/HtmlPreview*
    // components; these are the hooks into the renderer a merge could drop.
    markers: ["ARTIFACT_FENCE_LANG", "encodeArtifactsForMarkdown", "htmlPreviewKind", "<HtmlPreviewBlock"],
  },
  {
    name: "artifacts: only assistant text opts into artifact rendering",
    file: "components/MessageView.tsx",
    markers: ["onOpenFile={onOpenFile} artifacts>{block.text}"],
  },
  {
    name: "artifacts: ChatWindow publishes the session's artifacts",
    file: "components/ChatWindow.tsx",
    markers: ["useArtifactPublisher("],
  },
  {
    name: "artifacts: the right panel hosts artifact tabs",
    file: "components/AppShell.tsx",
    markers: ["setArtifactOpener(", "<ArtifactPanel", "artifactPanelTab", "artifactTabs.some((tab) => tab.id === tabId)"],
  },
  {
    name: "artifacts: tab bar knows the artifact tab kind",
    file: "components/TabBar.tsx",
    markers: ['kind?: "terminal" | "artifact"', 'tab.kind === "artifact"'],
  },
  {
    name: "artifacts: normal sessions get the prompt section",
    file: "lib/rpc-manager.ts",
    markers: ["createArtifactGuideExtension()"],
  },
  {
    name: "artifacts: General settings has the artifacts switch",
    file: "components/SettingsPanel.tsx",
    markers: ["<ArtifactsSettingRow />"],
  },
];

for (const extraction of EXTRACTIONS) {
  test(`${extraction.name}: extracted code does not reappear at its origin`, async () => {
    const origin = await read(extraction.origin);

    for (const symbol of extraction.movedDefinitions) {
      assert.equal(
        definesSymbol(origin, symbol),
        false,
        `${extraction.origin} defines ${symbol} again — an upstream merge probably resurrected it. ` +
          `It belongs in ${extraction.movedTo.join(" or ")}; importing it is fine, redefining it is not.`,
      );
    }

    for (const marker of extraction.absentFromOrigin) {
      assert.ok(
        !origin.includes(marker),
        `${extraction.origin} contains "${marker}" again — it moved to ` +
          `${extraction.movedTo.join(" or ")} and must not come back.`,
      );
    }
  });

  test(`${extraction.name}: the extraction targets still own the moved code`, async () => {
    const targets = await Promise.all(extraction.movedTo.map(read));

    for (const symbol of extraction.movedDefinitions) {
      assert.ok(
        targets.some((source) => definesSymbol(source, symbol)),
        `None of ${extraction.movedTo.join(", ")} defines ${symbol}.`,
      );
    }

    // Without this the origin-side check could pass simply because the code was
    // deleted everywhere rather than relocated.
    for (const marker of extraction.presentInTargets ?? extraction.absentFromOrigin) {
      assert.ok(
        targets.some((source) => source.includes(marker)),
        `"${marker}" is not owned by ` +
          `${extraction.movedTo.join(", ")} — it looks deleted, not moved.`,
      );
    }
  });

  test(`${extraction.name}: the origin still consumes the extraction`, async () => {
    const origin = await read(extraction.origin);

    for (const symbol of extraction.requiredInOrigin) {
      assert.ok(
        origin.includes(symbol),
        `${extraction.origin} no longer references ${symbol} — the merge may have reverted it ` +
          `to the upstream inline implementation.`,
      );
    }
  });
}

for (const feature of FORK_FEATURES) {
  test(`${feature.name}: fork changes survive upstream merges`, async () => {
    const source = await read(feature.file);

    for (const marker of feature.markers) {
      assert.ok(
        source.includes(marker),
        `${feature.file} lost "${marker}" — an upstream merge likely reverted this file toward ` +
          `its upstream form. Re-apply the fork change rather than deleting this assertion.`,
      );
    }

    for (const marker of feature.forbiddenMarkers ?? []) {
      assert.ok(
        !source.includes(marker),
        `${feature.file} contains "${marker}" again — an upstream merge re-adopted upstream's ` +
          `version of this region. The fork removed it deliberately; re-apply the removal ` +
          `rather than deleting this assertion.`,
      );
    }
  });
}
