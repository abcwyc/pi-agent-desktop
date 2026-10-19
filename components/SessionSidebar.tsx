"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useRef, type ReactNode } from "react";
import type { SessionInfo, SessionWorkspaceKind } from "@/lib/types";
import { listSessionFamilies } from "@/lib/session-family";
import { dispatchSessionRowContextMenu } from "@/lib/session-row-context-menu";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { useI18n } from "@/hooks/useI18n";
import { formatCompactRelativeTime, formatRelativeTime } from "@/lib/i18n/format";
import { createPortal } from "react-dom";
import { ProjectPicker, selectProjectDirectoryNative } from "./ProjectPicker";
import {
  ProjectContextMenu,
  currentCheckout,
  fetchProjectBranchMenu,
  fetchRemoteBranches,
  showNativeProjectBranchMenu,
  showNativeProjectWorktreeMenu,
  type ProjectBranchMenuState,
  type ProjectMenuView,
  type WorktreeEntry,
} from "./ProjectContextMenu";
import { useProjectWorktreeActions } from "@/hooks/useProjectWorktreeActions";
import { getRecentProjects } from "./path-ui";
import { APP_PREF_KEYS, getPref, getPrefJson, removePref, setPref, setPrefJson } from "@/lib/app-prefs";
import { groupByProject } from "@/lib/project-group";
import { getProjectDisplayName, getProjectDisplayNames } from "@/lib/project-display";
import { notifyDesktop } from "@/lib/desktop-notify";
import { revealItemInDirNative } from "@/lib/desktop-native";
import { isTauriDesktop } from "@/lib/desktop-updater";
import {
  canUseNativeMenu,
  menuPointBelow,
  showNativeMenu,
  type NativeMenuEntry,
  type NativeMenuPoint,
} from "@/lib/desktop-menu";
import { getDesktopPlatform, type DesktopPlatform } from "@/lib/desktop-window";
import { useWindowDrag } from "./desktop";
import { SessionSearch } from "./SessionSearch";
import { ProjectViewMenu, type ProjectViewMode } from "./ProjectViewMenu";
import { ScheduledSidebarRow } from "./scheduled/ScheduledSidebarRow";
import { isScheduledRunSession } from "@/hooks/useScheduledTasks";
import { prefetchSessionData } from "@/lib/session-data-cache";
import { isImeComposing } from "@/lib/ime";
import { appNotify } from "@/lib/notification-store";

function sessionListUrl(summary: boolean, force: boolean): string {
  if (summary) return "/api/sessions?summary=1";
  if (force) return "/api/sessions?force=1";
  return "/api/sessions";
}
interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean, entryId?: string, blockIndex?: number) => void;
  onNewSession?: (sessionId: string, cwd: string, workspaceKind?: SessionWorkspaceKind) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
    workspaceKind?: SessionWorkspaceKind,
  ) => void;
  onChatWorkspaceCwdChange?: (cwd: string | null) => void;
  onOpenTerminal?: (cwd: string) => void;
  /** Fired when a session that is not currently selected finishes running.
   *  Lets the app play a cross-workspace completion tone. */
  onBackgroundTaskDone?: () => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
  onProjectsChange?: (projectRoots: string[]) => void;
  headerControls?: ReactNode;
  /** Opens the Scheduled page; the row under New Session is absent without it. */
  onOpenScheduled?: () => void;
  scheduledOpen?: boolean;
}

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  /** Stable server-computed identity; never derive OS path semantics here. */
  projectKey: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  /** Canonical path of the checkout containing forCwd, resolved server-side. */
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}

interface ProjectSelection {
  root: string;
  key: string;
  kind: SessionWorkspaceKind;
}

// Server error codes with a translation; any other code is shown verbatim.
const FILE_MANAGER_ERROR_KEYS: Record<string, string> = {
  remote: "sidebar.openInExplorerRemoteOnly",
  "unsupported-platform": "sidebar.openInExplorerUnsupported",
};

const SESSION_DETAILS_HYDRATION_DELAY_MS = 750;

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  const parsed = getPrefJson<unknown>(APP_PREF_KEYS.unreadSessionIds);
  if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
  return new Set();
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  if (ids.size === 0) removePref(APP_PREF_KEYS.unreadSessionIds);
  else setPrefJson(APP_PREF_KEYS.unreadSessionIds, [...ids]);
}

function loadProjectViewMode(): ProjectViewMode {
  return getPref(APP_PREF_KEYS.projectViewMode) === "timeline" ? "timeline" : "grouped";
}




interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

const MAX_VISIBLE_PROJECT_SESSIONS = 5;
const MAX_VISIBLE_CHAT_SESSIONS = 5;

const SESSION_LIST_ITEM_HEIGHT = 54;

function focusSidebarTreeRow(current: HTMLElement, offset: number | "first" | "last") {
  const rows = Array.from(
    current.closest(".sidebar-project-tree")?.querySelectorAll<HTMLElement>("[data-sidebar-tree-row]") ?? [],
  );
  if (rows.length === 0) return;
  const index = rows.indexOf(current);
  const next = offset === "first" || index < 0
    ? rows[0]
    : offset === "last"
      ? rows[rows.length - 1]
      : rows[Math.max(0, Math.min(rows.length - 1, index + offset))];
  next.focus();
}

function handleSidebarTreeKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  handlers: {
    activate?: () => void;
    expand?: () => void;
    collapse?: () => void;
    rename?: () => void;
    requestDelete?: () => void;
  },
) {
  if (event.target !== event.currentTarget || isImeComposing(event)) return;
  const current = event.currentTarget;
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      focusSidebarTreeRow(current, 1);
      break;
    case "ArrowUp":
      event.preventDefault();
      focusSidebarTreeRow(current, -1);
      break;
    case "Home":
      event.preventDefault();
      focusSidebarTreeRow(current, "first");
      break;
    case "End":
      event.preventDefault();
      focusSidebarTreeRow(current, "last");
      break;
    case "ArrowRight":
      event.preventDefault();
      handlers.expand?.();
      break;
    case "ArrowLeft":
      event.preventDefault();
      handlers.collapse?.();
      break;
    case "Enter":
    case " ":
      event.preventDefault();
      handlers.activate?.();
      break;
    case "F2":
      event.preventDefault();
      handlers.rename?.();
      break;
    case "Delete":
      event.preventDefault();
      handlers.requestDelete?.();
      break;
  }
}

function treeContainsSession(node: SessionTreeNode, sessionId: string): boolean {
  return node.session.id === sessionId || node.children.some((child) => treeContainsSession(child, sessionId));
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onChatWorkspaceCwdChange, onProjectsChange, onBackgroundTaskDone, onRunningSessionIdsChange, onSessionsChange, headerControls, onOpenTerminal, onOpenScheduled, scheduledOpen = false }: Props) {
  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [chatWorkspaceCwd, setChatWorkspaceCwd] = useState<string | null>(null);
  const [chatVisibleCount, setChatVisibleCount] = useState(MAX_VISIBLE_CHAT_SESSIONS);
  // Tracked in a ref only: the version is compared against the polled value to
  // decide whether the list needs reloading, and no render reads it.
  const sessionListVersionRef = useRef<number | null>(null);
  const sessionLoadIdRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  // On macOS the native traffic lights float over this header. The mac-inset
  // class keeps its control row 48px tall so it shares the lights' centre line.
  const [desktopPlatform, setDesktopPlatform] = useState<DesktopPlatform>(null);
  useEffect(() => {
    if (isTauriDesktop()) setDesktopPlatform(getDesktopPlatform());
  }, []);
  const windowDrag = useWindowDrag();
  const [sessionQuery, setSessionQuery] = useState("");
  // Content search (server-side, across every session) vs. the default title
  // filter over the loaded project tree. Enter engages it; clearing the box
  // (Escape or the clear button) drops back to the title filter.
  const [contentSearch, setContentSearch] = useState(false);
  // Worktree switcher state
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const lastNotifiedProjectRef = useRef<{
    cwd: string | null;
    key: string | null;
    kind: SessionWorkspaceKind;
  } | null>(null);

  // The checked-out worktree for the current selection (falls back to the
  // project's main worktree when the selection is not itself a worktree).
  // Prefers the server-resolved currentWorktreePath: the browser cannot apply
  // Node path rules, so a raw comparison misses on Windows.
  const currentWorktree = worktreeState
    ? worktreeState.worktrees.find((worktree) => worktree.path === selectedCwd)
      ?? (worktreeState.forCwd === selectedCwd && worktreeState.currentWorktreePath
        ? worktreeState.worktrees.find((worktree) => worktree.path === worktreeState.currentWorktreePath)
        : undefined)
      ?? worktreeState.worktrees.find((worktree) => worktree.isMain)
    : undefined;
  const currentWorktreePath = currentWorktree?.path ?? null;

  /** Chat detection always comes from server-provided identity or the exact
   *  chat cwd the server returned. The browser never derives the hidden path. */
  const isChatCwd = useCallback((cwd: string | null): boolean => {
    if (!cwd) return false;
    if (chatWorkspaceCwd && cwd === chatWorkspaceCwd) return true;
    return allSessions.some((session) => session.workspaceKind === "chat" && session.cwd === cwd);
  }, [allSessions, chatWorkspaceCwd]);
  const selectedCwdIsChat = selectedCwd ? isChatCwd(selectedCwd) : false;

  /** Resolve the project root for a cwd from the freshest data available */
  const projectRootFor = useCallback((cwd: string | null): string | null => {
    if (!cwd) return null;
    if (isChatCwd(cwd)) return null;
    if (worktreeState && worktreeState.forCwd === cwd) return worktreeState.projectRoot;
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => w.path === cwd)) return worktreeState.projectRoot;
    const match = allSessions.find((s) => s.cwd === cwd);
    return match?.projectRoot ?? cwd;
  }, [allSessions, isChatCwd, worktreeState]);
  // Branch currently being checked out (name shown dimmed with a spinner)
  const [wtSwitchingBranch, setWtSwitchingBranch] = useState<string | null>(null);
  // Ticked by the poll/focus effect below so the worktree row reflects
  // branches checked out outside pi (terminal, IDE) without a manual reload.
  const [wtPollTick, setWtPollTick] = useState(0);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => {
    const stored = getPrefJson<unknown>(APP_PREF_KEYS.collapsedProjects);
    return Array.isArray(stored)
      ? new Set(stored.filter((root): root is string => typeof root === "string"))
      : new Set();
  });
  const [projectSessionPages, setProjectSessionPages] = useState<Record<string, number>>(() => {
    const stored = getPrefJson<unknown>(APP_PREF_KEYS.expandedProjects);
    if (Array.isArray(stored)) {
      // Older builds stored a set of fully expanded projects. Start those at
      // one extra page instead of restoring the unbounded list.
      return Object.fromEntries(
        stored
          .filter((root): root is string => typeof root === "string")
          .map((root) => [root, 1]),
      );
    }
    if (!stored || typeof stored !== "object") return {};
    return Object.fromEntries(
      Object.entries(stored).flatMap(([root, pages]) => (
        typeof pages === "number" && Number.isFinite(pages) && pages > 0
          ? [[root, Math.floor(pages)]]
          : []
      )),
    );
  });
  const [archivedProjectRoots, setArchivedProjectRoots] = useState<Set<string>>(() => {
    const stored = getPrefJson<unknown>(APP_PREF_KEYS.archivedProjects);
    return Array.isArray(stored)
      ? new Set(stored.filter((root): root is string => typeof root === "string"))
      : new Set();
  });
  const [projectViewMode, setProjectViewMode] = useState<ProjectViewMode>(loadProjectViewMode);
  const [projectViewMenuOpen, setProjectViewMenuOpen] = useState(false);
  const [projectViewMenuPos, setProjectViewMenuPos] = useState<{ top: number; left: number } | null>(null);
  const projectViewMenuRef = useRef<HTMLDivElement>(null);
  const projectViewMenuButtonRef = useRef<HTMLButtonElement>(null);
  const [projectMenu, setProjectMenu] = useState<{ root: string } | null>(null);
  const [projectMenuPos, setProjectMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [projectBranchMenu, setProjectBranchMenu] = useState<ProjectBranchMenuState | null>(null);
  const [projectMenuView, setProjectMenuView] = useState<ProjectMenuView>("actions");
  const [projectBranchLoading, setProjectBranchLoading] = useState(false);
  // "Open in file manager" on a project row. Only the server can raise a
  // file-manager window, and only when the browser runs on that same machine,
  // so the browser asks once and the menu shows the entry only where it works;
  // the desktop shell reveals natively through revealItemInDirNative instead.
  const [fileManagerAvailability, setFileManagerAvailability] = useState<{ supported: boolean; reason: string | null; platform: string } | null>(null);
  const [projectRevealError, setProjectRevealError] = useState<string | null>(null);
  useEffect(() => {
    if (isTauriDesktop()) return;
    let cancelled = false;
    fetch("/api/open-in-explorer")
      .then((res) => res.ok ? res.json() as Promise<{ supported: boolean; reason: string | null; platform: string }> : null)
      .then((data) => { if (!cancelled && data) setFileManagerAvailability(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const revealProjectInFileManager = useCallback(async (root: string) => {
    setProjectRevealError(null);
    if (isTauriDesktop()) {
      try {
        await revealItemInDirNative(root);
        setProjectMenu(null);
      } catch (e) {
        setProjectRevealError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    try {
      const res = await fetch("/api/open-in-explorer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: root }),
      });
      if (res.ok) {
        setProjectMenu(null);
        return;
      }
      const data = await res.json().catch(() => ({})) as { error?: string };
      const key = FILE_MANAGER_ERROR_KEYS[data.error ?? ""];
      setProjectRevealError(key ? t(key) : (data.error ?? `HTTP ${res.status}`));
    } catch (e) {
      setProjectRevealError(e instanceof Error ? e.message : String(e));
    }
  }, [t]);
  const fileManagerPlatform = isTauriDesktop()
    ? (desktopPlatform === "macos" ? "darwin" : desktopPlatform === "windows" ? "win32" : "linux")
    : fileManagerAvailability?.platform;
  const revealProjectLabel = t(
    fileManagerPlatform === "darwin"
      ? "sidebar.openInFinder"
      : fileManagerPlatform === "win32"
        ? "sidebar.openInExplorer"
        : "sidebar.openInFileManager",
  );
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const previousSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const sseAuthoritativeRef = useRef(false);
  const detailsHydrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Overlay-style scrollbar: `is-scrolling` shows the thumb only while the
  // project tree is actually scrolling.
  const listScrollHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const handleListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    e.currentTarget.classList.add("is-scrolling");
    if (listScrollHideTimerRef.current) clearTimeout(listScrollHideTimerRef.current);
    listScrollHideTimerRef.current = setTimeout(() => {
      listScrollRef.current?.classList.remove("is-scrolling");
      listScrollHideTimerRef.current = null;
    }, 800);
  }, []);
  useEffect(() => () => {
    if (listScrollHideTimerRef.current) clearTimeout(listScrollHideTimerRef.current);
  }, []);

  const loadSessions = useCallback(async (showLoading = false, force = false, summary = false) => {
    const loadId = ++sessionLoadIdRef.current;
    try {
      if (showLoading) setLoading(true);
      const res = await fetch(sessionListUrl(summary, force), {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as {
        sessions: SessionInfo[];
        sessionListVersion: number;
        runningSessionIds?: string[];
        completionNotificationSuppressedSessionIds?: string[];
        chatWorkspaceCwd?: string | null;
      };
      if (loadId !== sessionLoadIdRef.current) return;
      sessionListVersionRef.current = data.sessionListVersion;
      setAllSessions(data.sessions);
      setChatWorkspaceCwd(data.chatWorkspaceCwd ?? null);
      // Treat the fetched running set as an initial fallback only. Once the
      // live SSE stream is connected, a slow session-list fetch cannot overwrite it.
      if (!sseAuthoritativeRef.current) {
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      // Drop markers for deleted sessions and for subagents, whose completion
      // is intentionally silent even if an older client marked them unread.
      const unreadEligibleIds = new Set(
        data.sessions
          .filter((session) => session.relation?.kind !== "subagent")
          .map((session) => session.id),
      );
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => unreadEligibleIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
    } catch (e) {
      if (loadId === sessionLoadIdRef.current) setError(String(e));
    } finally {
      if (loadId === sessionLoadIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The server always returns the hidden cwd. Do not publish the initial
    // null before the first list load, or it would overwrite the shell's
    // earlier /api/chat-workspace answer.
    if (chatWorkspaceCwd) onChatWorkspaceCwdChange?.(chatWorkspaceCwd);
  }, [chatWorkspaceCwd, onChatWorkspaceCwdChange]);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    let active = true;

    if (isFirst) {
      // Header/stat metadata is enough to select the URL session and paint the
      // sidebar. Hydrate exact counts, names, and first messages once the
      // selected chat has had a chance to start loading.
      void loadSessions(true, false, true).then(() => {
        if (!active) return;
        detailsHydrationTimerRef.current = setTimeout(() => {
          detailsHydrationTimerRef.current = null;
          if (active) void loadSessions(false, true);
        }, SESSION_DETAILS_HYDRATION_DELAY_MS);
      });
    } else {
      void loadSessions(false, true);
    }

    return () => {
      active = false;
      if (detailsHydrationTimerRef.current) {
        clearTimeout(detailsHydrationTimerRef.current);
        detailsHydrationTimerRef.current = null;
      }
    };
  }, [loadSessions, refreshKey]);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  useEffect(() => {
    setPrefJson(APP_PREF_KEYS.archivedProjects, [...archivedProjectRoots]);
  }, [archivedProjectRoots]);

  useEffect(() => {
    if (collapsedProjects.size === 0) removePref(APP_PREF_KEYS.collapsedProjects);
    else setPrefJson(APP_PREF_KEYS.collapsedProjects, [...collapsedProjects]);
  }, [collapsedProjects]);

  useEffect(() => {
    if (Object.keys(projectSessionPages).length === 0) removePref(APP_PREF_KEYS.expandedProjects);
    else setPrefJson(APP_PREF_KEYS.expandedProjects, projectSessionPages);
  }, [projectSessionPages]);

  useEffect(() => {
    // Live running status via SSE — no polling. The server pushes the current
    // set of running session ids whenever any session starts/stops working.
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      source?.close();
      source = new EventSource("/api/agent/running/events");
      source.onmessage = async (e) => {
        try {
          const data = JSON.parse(e.data) as { type?: string; runningSessionIds?: string[]; sessionListVersion?: number };
          if (data.type === "running") {
            sseAuthoritativeRef.current = true;
            setRunningSessionIds(new Set(data.runningSessionIds ?? []));
          }
          if (typeof data.sessionListVersion === "number"
            && data.sessionListVersion !== sessionListVersionRef.current) {
            // Another window/process changed the list; reuse the invalidated
            // server cache instead of forcing a fresh scan.
            await loadSessions();
          }
        } catch {
          // ignore malformed frames
        }
      };
      source.onerror = () => {
        // Force a fresh connection after prolonged failures; EventSource alone
        // can stall after local server restarts in the desktop shell.
        if (source?.readyState === EventSource.CLOSED) {
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connect, 1_500);
        }
      };
    };

    connect();
    const onVisible = () => {
      if (document.visibilityState === "visible") connect();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", connect);

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", connect);
      source?.close();
    };
  }, [loadSessions]);

  useEffect(() => {
    if (!projectMenu) return;
    const handler = (e: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenu(null);
        setProjectMenuPos(null);
        setProjectBranchMenu(null);
        setProjectMenuView("actions");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [projectMenu]);

  useEffect(() => {
    if (!projectViewMenuOpen || !projectViewMenuPos) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (projectViewMenuRef.current?.contains(target)) return;
      if (projectViewMenuButtonRef.current?.contains(target)) return;
      setProjectViewMenuOpen(false);
      setProjectViewMenuPos(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isImeComposing(event)) {
        setProjectViewMenuOpen(false);
        setProjectViewMenuPos(null);
      }
    };
    const closeOnViewportChange = () => {
      setProjectViewMenuOpen(false);
      setProjectViewMenuPos(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", closeOnViewportChange, true);
    window.addEventListener("resize", closeOnViewportChange);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", closeOnViewportChange, true);
      window.removeEventListener("resize", closeOnViewportChange);
    };
  }, [projectViewMenuOpen, projectViewMenuPos]);

  useEffect(() => {
    onRunningSessionIdsChange?.(runningSessionIds);
  }, [onRunningSessionIdsChange, runningSessionIds]);

  useEffect(() => {
    onSessionsChange?.(allSessions);
  }, [allSessions, onSessionsChange]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const knownSubagentIds = new Set(
      allSessions
        .filter((session) => session.relation?.kind === "subagent")
        .map((session) => session.id),
    );
    // A scheduled run says how it ended (and what failed) through its own notification.
    const knownScheduledIds = new Set(
      allSessions
        .filter((session) => session.relation?.kind === "scheduled")
        .map((session) => session.id),
    );
    const completedWithNotifications = completedInBackground.filter(
      (id) => !previousSuppressedCompletionSessionIdsRef.current.has(id)
        && !knownSubagentIds.has(id)
        && !knownScheduledIds.has(id)
        && !isScheduledRunSession(id),
    );
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (completedWithNotifications.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        runningSessionIds.forEach((id) => next.delete(id));
        completedWithNotifications.forEach((id) => next.add(id));
        return next;
      });
    }
    const hasUnlistedRunningSession = newlyRunning.some(
      (id) => !allSessions.some((session) => session.id === id),
    );
    if (completedInBackground.length > 0 || hasUnlistedRunningSession) {
      loadSessions(false, true);
    }
    if (completedWithNotifications.length > 0) {
      onBackgroundTaskDone?.();
      const sessionName = (id: string) => {
        const session = allSessions.find((item) => item.id === id);
        return session?.name || session?.firstMessage || id.slice(0, 8);
      };
      for (const id of completedWithNotifications) {
        void notifyDesktop({
          title: "Pi Agent",
          body: `Finished: ${sessionName(id)}`,
        });
      }
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId, loadSessions, allSessions, onBackgroundTaskDone]);

  // A session that just started running has no row yet: pi had not flushed it
  // to disk when the list was last fetched. /api/sessions merges live runs, so
  // one refetch per unknown id is enough to make it appear mid-stream instead
  // of only when the turn ends.
  const refetchedRunningIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const known = new Set(allSessions.map((s) => s.id));
    const missing = [...runningSessionIds].filter(
      (id) => !known.has(id) && !refetchedRunningIdsRef.current.has(id),
    );
    if (missing.length === 0) return;
    missing.forEach((id) => refetchedRunningIdsRef.current.add(id));
    void loadSessions(false);
  }, [runningSessionIds, allSessions, loadSessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  const restoredRef = useRef(false);

  const projectSelection = useCallback((root: string, key: string, kind: SessionWorkspaceKind = "project"): ProjectSelection => ({
    root,
    key,
    kind,
  }), []);

  /** Resolve both display root and stable identity from server-provided data. */
  const projectFor = useCallback((cwd: string | null): ProjectSelection | null => {
    if (!cwd) return null;
    if (isChatCwd(cwd)) return projectSelection(cwd, cwd, "chat");
    // Custom-path identity validation lives in ProjectPicker (the extraction
    // boundary this file's sentinel test guards); identity here resolves from
    // server-provided worktree and session data only.
    if (worktreeState && worktreeState.forCwd === cwd) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => w.path === cwd)) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    const match = allSessions.find((session) => (
      session.cwd === cwd || (session.projectRoot ?? session.cwd) === cwd
    ));
    if (match?.workspaceKind === "chat") {
      return projectSelection(match.cwd, match.cwd, "chat");
    }
    return match
      ? projectSelection(match.projectRoot ?? match.cwd, workspaceKeyOf(match))
      : projectSelection(cwd, cwd);
  }, [worktreeState, allSessions, isChatCwd, projectSelection]);

  // Selecting a directory is also the explicit "add project" action. If the
  // project was previously removed from the sidebar, make it visible again
  // without touching any of the session files discovered for that directory.
  const activateProject = useCallback((cwd: string) => {
    const projectRoot = projectRootFor(cwd) ?? cwd;
    setArchivedProjectRoots((previous) => {
      if (!previous.has(projectRoot)) return previous;
      const next = new Set(previous);
      next.delete(projectRoot);
      return next;
    });
    setSelectedCwd(cwd);
  }, [projectRootFor]);

  // Notify parent only when the effective cwd actually changes (not when
  // projectRootFor identity changes due to session/worktree refreshes).
  useEffect(() => {
    const project = projectFor(selectedCwd);
    const previous = lastNotifiedProjectRef.current;
    const kind = project?.kind ?? "project";
    if (previous?.cwd === selectedCwd && previous.key === (project?.key ?? null) && previous.kind === kind) return;
    lastNotifiedProjectRef.current = { cwd: selectedCwd, key: project?.key ?? null, kind };
    onCwdChange?.(
      selectedCwd,
      project?.root ?? null,
      project?.key ?? null,
      project?.kind,
    );
  }, [selectedCwd, onCwdChange, projectFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // Load worktrees for the current effective cwd
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    if (!selectedCwd || selectedCwdIsChat) {
      setWorktreeState(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; projectKey?: string; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        if (d.error || !d.projectRoot) {
          setWorktreeState(null);
          return;
        }
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: d.projectRoot,
          projectKey: d.projectKey ?? d.projectRoot,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          currentWorktreePath: d.currentWorktreePath ?? null,
          worktrees: d.worktrees ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) setWorktreeState(null);
      });
    return () => { cancelled = true; };
  }, [selectedCwd, selectedCwdIsChat, wtRefreshKey, refreshKey, wtPollTick]);

  // Keep the worktree/branch display honest when branches are switched outside
  // pi (terminal, IDE, another client): poll while the tab is visible and
  // refresh on window focus. `git worktree list` is a cheap local op.
  useEffect(() => {
    const bump = () => setWtPollTick((t) => t + 1);
    const onVisible = () => {
      if (document.visibilityState === "visible") bump();
    };
    const id = setInterval(onVisible, 10_000);
    window.addEventListener("focus", bump);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", bump);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Most-recent projects, deduped by projectRoot, used to pick the default
  // cwd when no session is selected yet.
  const recentProjects = getRecentProjects(allSessions);
  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (loading || skipInitialProjectSelection) return;

    if (selectedCwd === null) {
      // If restoring a session, set cwd to match that session
      if (initialSessionId && !restoredRef.current) {
        restoredRef.current = true;
        const target = allSessions.find((s) => s.id === initialSessionId);
        if (target) {
          setSelectedCwd(target.cwd);
          onSelectSession(target, true);
          return;
        }
        // Session not found — notify parent so it can show the placeholder
        onInitialRestoreDone?.();
      }
      const projects = recentProjects;
      if (projects.length > 0) setSelectedCwd(projects[0]);
      else if (chatWorkspaceCwd) setSelectedCwd(chatWorkspaceCwd);
    }
  }, [allSessions, chatWorkspaceCwd, loading, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone, recentProjects]);

  // The worktree behind the active project's branch subtitle; falls back to
  // the main worktree while worktreeState catches up with a new selection.
  const currentWt = currentWorktree ?? null;

  const closeProjectMenu = useCallback(() => {
    setProjectMenu(null);
    setProjectMenuPos(null);
    setProjectBranchMenu(null);
    setProjectMenuView("actions");
  }, []);

  /** Loads the branch and worktree lists behind the DOM menu's branch / worktree pages. */
  const loadProjectMenuData = useCallback(async (projectRoot: string) => {
    setProjectBranchMenu({ root: projectRoot, isGit: false, branches: [], remoteBranches: [], worktrees: [], loaded: false });
    setProjectBranchLoading(true);
    try {
      const data = await fetchProjectBranchMenu(projectRoot);
      setProjectBranchMenu((prev) => prev?.root === projectRoot ? data : prev);
    } finally {
      setProjectBranchLoading(false);
    }
  }, []);

  const worktreeActions = useProjectWorktreeActions({
    onBranchesFetched: (projectRoot, lists) => {
      setProjectBranchMenu((prev) => prev?.root === projectRoot ? { ...prev, ...lists } : prev);
    },
    onWorktreeCreated: (projectRoot, path, branch) => {
      closeProjectMenu();
      // Register the new worktree right away so projectFor() resolves it to
      // the main repo before the refetch lands (keeps AppShell from treating
      // the new cwd as a different project).
      setWorktreeState((prev) => prev?.projectRoot === projectRoot ? {
        ...prev,
        forCwd: path,
        currentWorktreePath: path,
        worktrees: [...prev.worktrees, { path, branch, isMain: false }],
      } : prev);
      setSelectedCwd(path);
      setWtRefreshKey((k) => k + 1);
    },
    onWorktreeRemoved: (projectRoot, path) => {
      if (currentWorktreePath === path || selectedCwd === path) setSelectedCwd(projectRoot);
      setWtRefreshKey((k) => k + 1);
      void loadProjectMenuData(projectRoot);
      void loadSessions(false);
    },
  });
  const { reset: resetWorktreeActions } = worktreeActions;

  const showProjectMenuView = useCallback((projectRoot: string, view: ProjectMenuView) => {
    resetWorktreeActions();
    setProjectMenuView(view);
    if (view !== "actions" && projectBranchMenu?.root !== projectRoot) void loadProjectMenuData(projectRoot);
    if (view === "actions") setProjectBranchMenu(null);
  }, [loadProjectMenuData, projectBranchMenu, resetWorktreeActions]);

  /**
   * Opens the DOM menu at a native popup's point, for the steps a native menu
   * cannot do: typing a branch name, confirming a removal, showing an error.
   */
  const openDomProjectMenu = useCallback((projectRoot: string, at: NativeMenuPoint, view: ProjectMenuView, loaded?: ProjectBranchMenuState) => {
    const menuWidth = 240;
    setProjectMenu({ root: projectRoot });
    setProjectMenuPos({
      top: Math.max(8, Math.min(at.y, window.innerHeight - 160)),
      left: Math.max(8, Math.min(at.x, window.innerWidth - menuWidth - 8)),
    });
    setProjectMenuView(view);
    setProjectRevealError(null);
    if (loaded?.root === projectRoot) setProjectBranchMenu(loaded);
    else void loadProjectMenuData(projectRoot);
  }, [loadProjectMenuData]);

  const handleSwitchProjectBranch = useCallback(async (projectRoot: string, branch: string, loaded?: ProjectBranchMenuState, at?: NativeMenuPoint) => {
    if (wtSwitchingBranch) return;
    const branchData = loaded ?? (projectBranchMenu?.root === projectRoot ? projectBranchMenu : null);
    const checkout = branchData ? currentCheckout(branchData.worktrees, selectedCwd) ?? null : null;
    const holder = branchData?.worktrees.find((w) => w.branch === branch && w.path !== checkout?.path);
    if (holder) {
      setSelectedCwd(holder.path);
      closeProjectMenu();
      return;
    }
    if (checkout?.branch === branch) {
      setSelectedCwd(checkout.path);
      closeProjectMenu();
      return;
    }

    const cwd = checkout?.path ?? projectRoot;
    setWtSwitchingBranch(branch);
    worktreeActions.setError(null);
    let failure: string | null = null;
    try {
      const res = await fetch("/api/worktrees", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, branch }),
      });
      const data = await res.json().catch(() => ({})) as { branch?: string; error?: string };
      if (!res.ok || data.error || !data.branch) {
        failure = data.error ?? `HTTP ${res.status}`;
      } else {
        setSelectedCwd(cwd);
        closeProjectMenu();
        setWtRefreshKey((k) => k + 1);
        void loadSessions(false);
      }
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    } finally {
      setWtSwitchingBranch(null);
    }
    if (failure) {
      // A native popup has already closed, so show git's answer in the DOM menu.
      if (at) openDomProjectMenu(projectRoot, at, "branches", branchData ?? undefined);
      worktreeActions.setError(failure);
    }
  }, [closeProjectMenu, loadSessions, openDomProjectMenu, projectBranchMenu, selectedCwd, worktreeActions, wtSwitchingBranch]);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback((s: SessionInfo, entryId?: string, blockIndex?: number) => {
    setAllSessions((current) => current.some((session) => session.id === s.id) ? current : [s, ...current]);
    if (s.cwd) setSelectedCwd(s.cwd);
    onSelectSession(s, false, entryId, blockIndex);
  }, [onSelectSession]);

  const handleNewSession = useCallback((cwdOverride?: string, workspaceKindOverride?: SessionWorkspaceKind) => {
    const cwd = cwdOverride ?? selectedCwd ?? chatWorkspaceCwd;
    if (!cwd) return;
    const workspaceKind = workspaceKindOverride ?? (isChatCwd(cwd) ? "chat" : "project");
    // Creating a session is also the activation gesture for an archived
    // project. This keeps the archive list useful without a second step.
    if (workspaceKind === "project") {
      const projectRoot = projectRootFor(cwd) ?? cwd;
      if (archivedProjectRoots.has(projectRoot)) {
        setArchivedProjectRoots((prev) => {
          const next = new Set(prev);
          next.delete(projectRoot);
          return next;
        });
      }
    }
    if (cwd !== selectedCwd) setSelectedCwd(cwd);
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, cwd, workspaceKind);
  }, [selectedCwd, chatWorkspaceCwd, archivedProjectRoots, onNewSession, projectRootFor, isChatCwd]);

  const handleAddProject = useCallback(async () => {
    if (!isTauriDesktop()) {
      setProjectPickerOpen(true);
      return;
    }

    try {
      const cwd = await selectProjectDirectoryNative(selectedCwd, homeDir);
      if (cwd) activateProject(cwd);
    } catch (error) {
      console.error("Failed to select project folder:", error);
    }
  }, [selectedCwd, homeDir, activateProject]);

  const archiveProject = useCallback((projectRoot: string) => {
    setArchivedProjectRoots((prev) => {
      const next = new Set(prev);
      next.add(projectRoot);
      return next;
    });
    closeProjectMenu();
  }, [closeProjectMenu]);

  // Desktop shell: native popup versions of the project menu and its branch
  // and worktree lists. `projectMenu` stays set while one is up (it keeps the
  // row's "…" visible) but `projectMenuPos` stays null, so the DOM menu never
  // renders — until a step needs it (openDomProjectMenu).
  const { setError: setWorktreeError, requestRemove: requestWorktreeRemoval } = worktreeActions;
  const showNativeBranchMenu = useCallback(function showBranches(projectRoot: string, at: NativeMenuPoint): Promise<void> {
    return showNativeProjectBranchMenu({
      projectRoot,
      at,
      selectedCwd,
      switchingBranch: wtSwitchingBranch,
      t,
      onSwitch: (root, branch, loaded) => void handleSwitchProjectBranch(root, branch, loaded, at),
      onFetch: (root) => void (async () => {
        try {
          await fetchRemoteBranches(root);
          await showBranches(root, at);
        } catch (e) {
          openDomProjectMenu(root, at, "branches");
          setWorktreeError(e instanceof Error ? e.message : String(e));
        }
      })(),
    });
  }, [handleSwitchProjectBranch, openDomProjectMenu, selectedCwd, setWorktreeError, t, wtSwitchingBranch]);

  const showNativeWorktreeMenu = useCallback((projectRoot: string, at: NativeMenuPoint) => showNativeProjectWorktreeMenu({
    projectRoot,
    at,
    selectedCwd,
    t,
    onSelect: (path) => setSelectedCwd(path),
    onNew: (root, point, loaded) => {
      resetWorktreeActions();
      openDomProjectMenu(root, point, "new-worktree", loaded);
    },
    onRemove: (root, path, point, loaded) => {
      resetWorktreeActions();
      openDomProjectMenu(root, point, "worktrees", loaded);
      requestWorktreeRemoval(path);
    },
  }), [openDomProjectMenu, requestWorktreeRemoval, resetWorktreeActions, selectedCwd, t]);

  const showNativeProjectMenu = useCallback(async (projectRoot: string, at: NativeMenuPoint): Promise<boolean> => {
    setProjectMenu({ root: projectRoot });
    setProjectMenuPos(null);
    setProjectBranchMenu(null);
    setProjectRevealError(null);
    const shown = await showNativeMenu([
      { label: `${t("sidebar.switchBranch")}…`, onSelect: () => void showNativeBranchMenu(projectRoot, at) },
      { label: t("sidebar.worktrees"), onSelect: () => void showNativeWorktreeMenu(projectRoot, at) },
      ...(onOpenTerminal
        ? [{ label: t("sidebar.openTerminalHere"), onSelect: () => onOpenTerminal(projectRoot) }]
        : []),
      { label: revealProjectLabel, onSelect: () => void revealProjectInFileManager(projectRoot) },
      { kind: "separator" as const },
      { label: t("sidebar.archiveProject"), onSelect: () => archiveProject(projectRoot) },
    ], at);
    setProjectMenu((current) => (current?.root === projectRoot ? null : current));
    return shown;
  }, [archiveProject, onOpenTerminal, revealProjectInFileManager, revealProjectLabel, showNativeBranchMenu, showNativeWorktreeMenu, t]);

  const openProjectMenu = useCallback((e: React.MouseEvent<HTMLButtonElement>, projectRoot: string) => {
    e.stopPropagation();
    resetWorktreeActions();
    if (canUseNativeMenu()) {
      void showNativeProjectMenu(projectRoot, menuPointBelow(e.currentTarget));
      return;
    }
    if (projectMenu?.root === projectRoot) {
      closeProjectMenu();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const menuWidth = 168;
    const menuHeight = 42;
    const left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8));
    const top = rect.bottom + menuHeight > window.innerHeight - 8
      ? rect.top - menuHeight - 4
      : rect.bottom + 4;
    setProjectMenu({ root: projectRoot });
    setProjectMenuPos({ top, left });
    setProjectBranchMenu(null);
    setProjectMenuView("actions");
    setProjectRevealError(null);
  }, [closeProjectMenu, projectMenu, resetWorktreeActions, showNativeProjectMenu]);

  // Phase A: project tree — groups sessions by project root. Sorting is
  const trimmedSessionQuery = sessionQuery.trim().toLowerCase();
  // Runs of scheduled tasks live under Scheduled, not in the project tree: an
  // hourly task would otherwise bury the sessions the user started themselves.
  const treeSessions = allSessions.filter((session) => session.relation?.kind !== "scheduled");
  const filteredSessions = trimmedSessionQuery
    ? treeSessions.filter((session) =>
        (session.name ?? "").toLowerCase().includes(trimmedSessionQuery)
        || session.firstMessage.toLowerCase().includes(trimmedSessionQuery))
    : treeSessions;
  const chatSessions = filteredSessions
    .filter((session) => session.workspaceKind === "chat" || isChatCwd(session.cwd))
    .sort((a, b) => b.modified.localeCompare(a.modified));
  const projectSessions = filteredSessions.filter(
    (session) => session.workspaceKind !== "chat" && !isChatCwd(session.cwd),
  );
  const chatFamilies = listSessionFamilies(chatSessions);
  const sessionFamilies = listSessionFamilies(projectSessions);
  const allProjects = groupByProject(projectSessions, { runningIds: runningSessionIds, unreadIds: unreadSessionIds });
  const activeProjects = allProjects.filter((group) => !archivedProjectRoots.has(group.projectRoot));
  const activeProjectRoots = activeProjects.map((group) => group.projectRoot);
  const projectDisplayNames = getProjectDisplayNames(activeProjectRoots);
  const canCollapseAllProjects = activeProjects.some((group) => !collapsedProjects.has(group.projectRoot));
  const canExpandAllProjects = activeProjects.some((group) => collapsedProjects.has(group.projectRoot));
  const timelineFamilies = projectViewMode === "timeline"
    ? sessionFamilies.filter((family) => (
        !archivedProjectRoots.has(family.root.projectRoot ?? family.root.cwd)
      )).sort((a, b) => b.root.modified.localeCompare(a.root.modified))
    : [];
  const timelineRootNodes = new Map<string, SessionTreeNode>();
  for (const family of timelineFamilies) {
    const [rootNode] = buildSessionTree([family.root, ...family.subagents]);
    if (rootNode) timelineRootNodes.set(family.root.id, rootNode);
  }
  useEffect(() => {
    const projectRoots = activeProjects.map((group) => group.projectRoot);
    onProjectsChange?.(projectRoots);
  }, [activeProjects, onProjectsChange]);
  // Sessions of every worktree in the selected project are shown together
  const selectedProjectObject = projectFor(selectedCwd);
  const selectedProjectRoot = selectedProjectObject?.kind === "project"
    ? selectedProjectObject.root
    : null;
  let visibleChatFamilies = trimmedSessionQuery
    ? chatFamilies
    : chatFamilies.slice(0, chatVisibleCount);
  if (!trimmedSessionQuery && selectedSessionId) {
    const selectedFamily = chatFamilies.find((family) => (
      family.root.id === selectedSessionId
      || family.subagents.some((session) => session.id === selectedSessionId)
    ));
    if (selectedFamily && !visibleChatFamilies.includes(selectedFamily)) {
      visibleChatFamilies = [...visibleChatFamilies.slice(0, -1), selectedFamily];
    }
  }
  const hiddenChatFamilyCount = chatFamilies.length - visibleChatFamilies.length;

  const renderProjectGroup = (group: ReturnType<typeof groupByProject>[number]) => {
    const isCollapsed = !trimmedSessionQuery && collapsedProjects.has(group.projectRoot);
    const isActive = group.projectRoot === projectRootFor(selectedCwd);
    const runningCount = group.runningIds.size;
    const unreadCount = group.unreadIds.size;
    const groupTree = buildSessionTree(group.sessions);
    const extraPages = projectSessionPages[group.projectRoot] ?? 0;
    const visibleSessionLimit = MAX_VISIBLE_PROJECT_SESSIONS * (extraPages + 1);
    let visibleGroupTree = trimmedSessionQuery
      ? groupTree
      : groupTree.slice(0, visibleSessionLimit);
    // Keep the selected session reachable even when it is older than the
    // collapsed preview window.
    if (!trimmedSessionQuery && selectedSessionId) {
      const selectedRoot = groupTree.find((node) => treeContainsSession(node, selectedSessionId));
      if (selectedRoot && !visibleGroupTree.includes(selectedRoot)) {
        visibleGroupTree = [...visibleGroupTree.slice(0, -1), selectedRoot];
      }
    }
    const hiddenSessionCount = groupTree.length - visibleGroupTree.length;
    const branchSubtitle = isActive && currentWt?.branch
      ? currentWt.branch
      : group.branches.length === 1
        ? group.branches[0]
        : group.branches.length > 1
          ? `${group.branches[0]} +${group.branches.length - 1}`
          : null;
    const toggleCollapse = () => {
      setCollapsedProjects((prev) => {
        const next = new Set(prev);
        if (next.has(group.projectRoot)) next.delete(group.projectRoot);
        else next.add(group.projectRoot);
        return next;
      });
      setProjectSessionPages((prev) => {
        if (!(group.projectRoot in prev)) return prev;
        const next = { ...prev };
        delete next[group.projectRoot];
        return next;
      });
      if (!isActive) setSelectedCwd(group.projectRoot);
    };

    const isMenuOpen = projectMenu?.root === group.projectRoot;
    const rowTitle = branchSubtitle ? `${group.projectRoot} · ${branchSubtitle}` : group.projectRoot;

    return (
      <div key={group.projectRoot} className={`sidebar-project-tree-group${isCollapsed ? " is-collapsed" : ""}${isActive ? " is-active" : ""}`}>
        <div className={`sidebar-project-tree-row${isMenuOpen ? " is-menu-open" : ""}`}>
          <button
            type="button"
            className="sidebar-project-tree-row-main"
            data-sidebar-tree-row
            tabIndex={0}
            role="treeitem"
            aria-selected={isActive}
            onClick={toggleCollapse}
            aria-expanded={!isCollapsed}
            title={rowTitle}
            onKeyDown={(e) => handleSidebarTreeKeyDown(e, {
              activate: toggleCollapse,
              expand: () => {
                if (isCollapsed) toggleCollapse();
              },
              collapse: () => {
                if (!isCollapsed) toggleCollapse();
              },
            })}
          >
            <span className="sidebar-project-tree-folder" aria-hidden="true">
              {/* Closed folder vs. folder with its flap lifted; the closed one
                  carries a faint fill so the pair reads as shut / open. */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                {isCollapsed ? (
                  <path
                    d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
                    fill="currentColor"
                    fillOpacity="0.1"
                  />
                ) : (
                  <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
                )}
              </svg>
            </span>
            <span className="sidebar-project-tree-name">
              {projectDisplayNames.get(group.projectRoot) ?? group.displayName}
            </span>
            {/* A folded project hides its rows, so the count (and any running
                or unread chips) must stay readable on the header itself. */}
            {isCollapsed && (
              <span className="sidebar-project-tree-count" title={t("sidebar.sessionCount", { count: groupTree.length })}>
                ({groupTree.length})
              </span>
            )}
            {isCollapsed && (
              <span className="sidebar-project-tree-meta">
                {runningCount > 0 && (
                  <span className="sidebar-project-tree-chip is-running" title={t("sidebar.runningCount", { count: runningCount })}>
                    {runningCount}
                  </span>
                )}
                {unreadCount > 0 && (
                  <span className="sidebar-project-tree-chip is-unread" title={t("sidebar.unreadCount", { count: unreadCount })}>
                    {unreadCount}
                  </span>
                )}
              </span>
            )}
          </button>
          {/* Hover-only overlay at the row's trailing edge: it covers the tail of a
              long name instead of reserving width the rest of the time. */}
          <div className="sidebar-project-tree-row-actions" data-no-drag>
            <button
              type="button"
              className="sidebar-project-tree-action"
              onClick={() => handleNewSession(group.projectRoot)}
              title={t("sidebar.newSessionTitle", { path: group.projectRoot })}
              aria-label={t("sidebar.newSessionTitle", { path: group.projectRoot })}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
              <button
              type="button"
              className="sidebar-project-tree-action sidebar-project-tree-more"
              onClick={(e) => openProjectMenu(e, group.projectRoot)}
              title={t("sidebar.moreActions")}
              aria-label={t("sidebar.moreActions")}
                aria-haspopup="menu"
              aria-expanded={isMenuOpen}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="19" cy="12" r="1.6" />
              </svg>
            </button>
          </div>
        </div>
        {!isCollapsed && (
          <div className="sidebar-project-tree-children">
            {visibleGroupTree.map((node) => {
              const nodeFamily = sessionFamilies.find(
                (family) => family.root.id === node.session.id,
              );
              return (
              <SessionFamilyItem
                key={node.session.id}
                node={node}
                familySessions={nodeFamily ? [nodeFamily.root, ...nodeFamily.subagents] : undefined}
                selectedSessionId={selectedSessionId}
                runningSessionIds={runningSessionIds}
                unreadSessionIds={unreadSessionIds}
                onSelectSession={handleSelectSessionFromList}
                onRenamed={loadSessions}
                onSessionDeleted={(id) => {
                  onSessionDeleted?.(id);
                  loadSessions();
                }}
              />
              );
            })}
            {hiddenSessionCount > 0 && (
              <button
                type="button"
                className="sidebar-project-tree-show-more"
                onClick={() => setProjectSessionPages((prev) => ({
                  ...prev,
                  [group.projectRoot]: (prev[group.projectRoot] ?? 0) + 1,
                }))}
              >
                {t("sidebar.showMoreSessions", {
                  count: Math.min(MAX_VISIBLE_PROJECT_SESSIONS, hiddenSessionCount),
                })}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderTimeline = () => (
    <div className="sidebar-project-timeline">
      {timelineFamilies.map((family) => {
        const node = timelineRootNodes.get(family.root.id);
        if (!node) return null;
        const projectRoot = family.root.projectRoot ?? family.root.cwd;
        const projectName = projectDisplayNames.get(projectRoot)
          ?? getProjectDisplayName(projectRoot, activeProjectRoots);
        const familySessions = [family.root, ...family.subagents];
        return (
          <SessionFamilyItem
            key={family.root.id}
            node={node}
            familySessions={familySessions}
            subtitle={projectName}
            selectedSessionId={selectedSessionId}
            runningSessionIds={runningSessionIds}
            unreadSessionIds={unreadSessionIds}
            onSelectSession={handleSelectSessionFromList}
            onRenamed={loadSessions}
            onSessionDeleted={(id) => {
              onSessionDeleted?.(id);
              loadSessions();
            }}
          />
        );
      })}
    </div>
  );

  const closeProjectViewMenu = () => {
    setProjectViewMenuOpen(false);
    setProjectViewMenuPos(null);
  };

  const changeProjectViewMode = (mode: ProjectViewMode) => {
    setProjectViewMode(mode);
    setPref(APP_PREF_KEYS.projectViewMode, mode);
    closeProjectViewMenu();
  };

  const collapseAllProjects = () => {
    setCollapsedProjects(new Set(activeProjectRoots));
    setProjectSessionPages({});
    closeProjectViewMenu();
  };

  const expandAllProjects = () => {
    setCollapsedProjects(new Set());
    closeProjectViewMenu();
  };

  const openProjectViewDomMenu = (anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const width = 216;
    const estimatedHeight = 180;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const top = rect.bottom + 4 + estimatedHeight > window.innerHeight - 8
      ? Math.max(8, rect.top - estimatedHeight - 4)
      : rect.bottom + 4;
    setProjectViewMenuPos({ top, left });
    setProjectViewMenuOpen(true);
  };

  const toggleProjectViewMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (projectViewMenuOpen && projectViewMenuPos) {
      closeProjectViewMenu();
      return;
    }
    if (projectViewMenuOpen) return;
    setProjectMenu(null);
    setProjectMenuPos(null);
    const anchor = event.currentTarget;
    const controlsDisabled = projectViewMode !== "grouped";
    if (!canUseNativeMenu()) {
      openProjectViewDomMenu(anchor);
      return;
    }
    const entries: NativeMenuEntry[] = [
      {
        label: t("sidebar.projectViewGrouped"),
        checked: projectViewMode === "grouped",
        onSelect: () => changeProjectViewMode("grouped"),
      },
      {
        label: t("sidebar.projectViewTimeline"),
        checked: projectViewMode === "timeline",
        onSelect: () => changeProjectViewMode("timeline"),
      },
      { kind: "separator" },
      {
        label: t("sidebar.collapseAllProjects"),
        disabled: controlsDisabled || !canCollapseAllProjects,
        onSelect: collapseAllProjects,
      },
      {
        label: t("sidebar.expandAllProjects"),
        disabled: controlsDisabled || !canExpandAllProjects,
        onSelect: expandAllProjects,
      },
    ];
    setProjectViewMenuOpen(true);
    setProjectViewMenuPos(null);
    void showNativeMenu(entries, menuPointBelow(anchor, "right")).then((shown) => {
      if (shown) {
        setProjectViewMenuOpen(false);
        return;
      }
      openProjectViewDomMenu(anchor);
    });
  };

  return (
    <div className="session-sidebar" style={{ display: "flex", flexDirection: "column", flex: "1 1 0%", minHeight: 0, height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div
        className={`session-sidebar-header${desktopPlatform === "macos" ? " session-sidebar-header--mac-inset" : ""}`}
        data-tauri-drag-region={desktopPlatform ? true : undefined}
        {...windowDrag}
        style={{
          padding: "12px 10px 10px",
          borderBottom: "var(--hairline) solid var(--border)",
          flexShrink: 0,
        }}
      >
        {/* Window-chrome controls row: right-aligned (theme + collapse). On
            macOS the native traffic lights share the row's 48px centre line. */}
        {headerControls && (
          <div className="sidebar-controls-row">
            {headerControls}
          </div>
        )}

        {/* Row 1: New Session — full-width flat row, Claude Desktop style */}
        <button
          className="sidebar-header-row sidebar-new-row"
          onClick={() => handleNewSession()}
          disabled={!selectedCwd && !chatWorkspaceCwd}
          title={
            selectedCwd
              ? `${selectedCwdIsChat
                ? t("sidebar.newChatTitle")
                : t("sidebar.newSessionTitle", { path: selectedCwd })} (⌘/Ctrl+N)`
              : chatWorkspaceCwd
                ? t("sidebar.newChatTitle")
                : t("sidebar.selectProject")
          }
        >
          <span className="sidebar-new-plus" aria-hidden="true">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="1.5" x2="6" y2="10.5" />
              <line x1="1.5" y1="6" x2="10.5" y2="6" />
            </svg>
          </span>
          {t("sidebar.newChat")}
        </button>

        {onOpenScheduled && <ScheduledSidebarRow active={scheduledOpen} onOpen={onOpenScheduled} />}
      </div>
{/* Session search — keeps the original sidebar search styling and
          narrows the project tree to matching titles / first messages. Enter is
          the confirmation for the server-side content search across every
          session; there is no mode button, so Escape (or the clear button) is
          the way back to the title filter. */}
      <div className="sidebar-search-wrap" data-no-drag>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="sidebar-search-icon">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="search"
          className="sidebar-search-input"
          value={sessionQuery}
          onChange={(e) => setSessionQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // Committing an IME candidate must not fire the search.
              if (isImeComposing(e) || !sessionQuery.trim()) return;
              e.preventDefault();
              setContentSearch(true);
              return;
            }
            if (e.key === "Escape" && !isImeComposing(e)) {
              e.stopPropagation();
              // Content results first, then the query, then the field itself.
              if (contentSearch) setContentSearch(false);
              else if (sessionQuery) setSessionQuery("");
              else e.currentTarget.blur();
            }
          }}
          title={t("sidebar.searchAllHint")}
          placeholder={t("sidebar.searchSessions")}
          aria-label={t("sidebar.searchSessions")}
        />
        {sessionQuery && (
          <button
            type="button"
            className="sidebar-search-clear"
            onClick={() => {
              setSessionQuery("");
              setContentSearch(false);
            }}
            title={t("sidebar.clearSearch")}
            aria-label={t("sidebar.clearSearch")}
          >
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <line x1="2" y1="2" x2="8" y2="8" />
              <line x1="8" y1="2" x2="2" y2="8" />
            </svg>
          </button>
        )}
      </div>
      {/* Chats sit beside Projects: the same session model and event stream,
          but a model-only workspace that never enters project grouping. */}
      <SessionSearch
        open={contentSearch}
        query={sessionQuery}
        selectedSessionId={selectedSessionId}
        onSelectSession={handleSelectSessionFromList}
      >
      <div
        ref={listScrollRef}
        className="sidebar-project-tree"
        role="tree"
        aria-label={`${t("sidebar.chats")} / ${t("sidebar.projects")}`}
        onScroll={handleListScroll}
      >
        <div className="sidebar-project-tree-header sidebar-chats-header">
          <span className="sidebar-project-tree-title">{t("sidebar.chats")}</span>
          <button
            type="button"
            className="sidebar-chats-add"
            onClick={() => handleNewSession(chatWorkspaceCwd ?? undefined, "chat")}
            disabled={!chatWorkspaceCwd}
            title={t("sidebar.newChatTitle")}
            aria-label={t("sidebar.newChatTitle")}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
        <div className="sidebar-project-tree-children sidebar-chats-list">
          {visibleChatFamilies.map((family) => {
            const [node] = buildSessionTree([family.root, ...family.subagents]);
            if (!node) return null;
            return (
              <SessionFamilyItem
                key={family.root.id}
                node={node}
                familySessions={[family.root, ...family.subagents]}
                selectedSessionId={selectedSessionId}
                runningSessionIds={runningSessionIds}
                unreadSessionIds={unreadSessionIds}
                onSelectSession={handleSelectSessionFromList}
                onRenamed={loadSessions}
                onSessionDeleted={(id) => {
                  onSessionDeleted?.(id);
                  loadSessions();
                }}
              />
            );
          })}
          {!loading && !error && chatFamilies.length === 0 && (
            <div className="sidebar-chats-empty">
              {trimmedSessionQuery ? t("sidebar.noMatchingSessions") : t("sidebar.noChats")}
            </div>
          )}
          {hiddenChatFamilyCount > 0 && (
            <button
              type="button"
              className="sidebar-project-tree-show-more"
              onClick={() => setChatVisibleCount((count) => count + MAX_VISIBLE_CHAT_SESSIONS)}
            >
              {t("sidebar.showMoreSessions", {
                count: Math.min(MAX_VISIBLE_CHAT_SESSIONS, hiddenChatFamilyCount),
              })}
            </button>
          )}
        </div>

        <div className={`sidebar-project-tree-header${projectViewMenuOpen ? " is-menu-open" : ""}`}>
          <span className="sidebar-project-tree-title">{t("sidebar.projects")}</span>
          <div className="sidebar-project-tree-tools">
            <button
              ref={projectViewMenuButtonRef}
              type="button"
              className={`sidebar-project-tree-menu${projectViewMenuOpen ? " is-open" : ""}`}
              title={t("sidebar.projectViewMenu")}
              aria-label={t("sidebar.projectViewMenu")}
              aria-haspopup="menu"
              aria-expanded={projectViewMenuOpen}
              onClick={toggleProjectViewMenu}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="19" cy="12" r="1.6" />
              </svg>
            </button>
            <button
              type="button"
              className="sidebar-project-tree-add"
              onClick={() => void handleAddProject()}
              title={t("sidebar.addProject")}
              aria-label={t("sidebar.addProject")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
        </div>
        {allProjects.length === 0 ? (
          <div className="sidebar-project-tree-empty">
            {loading
              ? t("sidebar.loading")
              : error
                ? (
                  // A failed list load must not read as "no projects": that
                  // offers "Add project" as if the user's sessions were gone.
                  <div className="sidebar-empty-action" role="alert">
                    <span className="sidebar-empty-text" title={error}>{t("sidebar.loadFailed")}</span>
                    <button
                      type="button"
                      className="sidebar-empty-add"
                      onClick={() => void loadSessions(true, true)}
                    >
                      <span>{t("common.retry")}</span>
                    </button>
                  </div>
                )
              : trimmedSessionQuery
                ? t("sidebar.noMatchingSessions")
                : (
                  <div className="sidebar-empty-action">
                    <span className="sidebar-empty-text">{t("sidebar.noProjects")}</span>
                    <button
                      type="button"
                      className="sidebar-empty-add"
                      onClick={() => void handleAddProject()}
                      title={t("sidebar.addProject")}
                      aria-label={t("sidebar.addProject")}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      <span>{t("sidebar.addProject")}</span>
                    </button>
                  </div>
                )}
          </div>
        ) : projectViewMode === "timeline"
          ? renderTimeline()
          : activeProjects.map((group) => renderProjectGroup(group))}
      </div>
      </SessionSearch>
      {projectViewMenuOpen && projectViewMenuPos && (
        <ProjectViewMenu
          menuRef={projectViewMenuRef}
          pos={projectViewMenuPos}
          mode={projectViewMode}
          canCollapseAll={canCollapseAllProjects}
          canExpandAll={canExpandAllProjects}
          controlsDisabled={projectViewMode !== "grouped"}
          onModeChange={changeProjectViewMode}
          onCollapseAll={collapseAllProjects}
          onExpandAll={expandAllProjects}
          onClose={() => setProjectViewMenuPos(null)}
        />
      )}
      {projectMenu && projectMenuPos && (
        <ProjectContextMenu
          menuRef={projectMenuRef}
          projectRoot={projectMenu.root}
          pos={projectMenuPos}
          view={projectMenuView}
          branchMenu={projectBranchMenu}
          branchLoading={projectBranchLoading}
          selectedCwd={selectedCwd}
          switchingBranch={wtSwitchingBranch}
          fetching={worktreeActions.fetching}
          worktreeBusy={worktreeActions.busy}
          worktreeError={worktreeActions.error}
          confirmRemove={worktreeActions.confirmRemove}
          newBranch={worktreeActions.newBranch}
          canReveal={isTauriDesktop() || fileManagerAvailability?.supported === true}
          revealLabel={revealProjectLabel}
          projectRevealError={projectRevealError}
          t={t}
          onShowBranches={() => showProjectMenuView(projectMenu.root, "branches")}
          onShowWorktrees={() => showProjectMenuView(projectMenu.root, "worktrees")}
          onShowNewWorktree={() => showProjectMenuView(projectMenu.root, "new-worktree")}
          onBackToActions={() => showProjectMenuView(projectMenu.root, "actions")}
          onClose={closeProjectMenu}
          onOpenTerminal={onOpenTerminal ? () => {
            const cwd = projectMenu.root;
            closeProjectMenu();
            onOpenTerminal(cwd);
          } : undefined}
          onReveal={() => void revealProjectInFileManager(projectMenu.root)}
          onArchive={() => archiveProject(projectMenu.root)}
          onSwitchBranch={(branch) => void handleSwitchProjectBranch(projectMenu.root, branch)}
          onFetch={() => void worktreeActions.fetchBranches(projectMenu.root)}
          onSelectWorktree={(path) => {
            setSelectedCwd(path);
            closeProjectMenu();
          }}
          onRequestRemove={worktreeActions.requestRemove}
          onConfirmRemove={(removal) => void worktreeActions.remove(projectMenu.root, removal)}
          onCancelRemove={worktreeActions.cancelRemove}
          onNewBranchChange={worktreeActions.setNewBranch}
          onCreateWorktree={() => void worktreeActions.create(projectMenu.root)}
        />
      )}
      {projectPickerOpen && (
        <div className="project-picker-modal-overlay" role="dialog" aria-modal="true" onClick={() => setProjectPickerOpen(false)}>
          <div className="project-picker-modal-shell" onClick={(e) => e.stopPropagation()}>
            <ProjectPicker
              recentProjects={recentProjects}
              selectedCwd={selectedCwdProp && !isChatCwd(selectedCwdProp) ? selectedCwdProp : null}
              selectedProject={selectedProjectRoot}
              homeDir={homeDir}
              onSelectCwd={(cwd) => {
                activateProject(cwd);
                setProjectPickerOpen(false);
              }}
              variant="block"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function SessionFamilyItem({
  node,
  depth = 0,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  familySessions,
  subtitle,
}: {
  node: SessionTreeNode;
  familySessions?: SessionInfo[];
  depth?: number;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  /** Cross-project context, shown by the chronological sidebar view. */
  subtitle?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div
      className="session-tree-item"
      data-session-depth={depth}
      aria-level={depth + 1}
      style={depth > 0 ? { marginLeft: depth * 14 } : undefined}
    >
      <div style={{ position: "relative" }}>
        <SessionItem
          session={node.session}
          isSubagentChild={Boolean(node.session.relation?.kind === "subagent")}
          isSelected={familySessions
            ? familySessions.some((session) => session.id === selectedSessionId)
            : node.session.id === selectedSessionId}
          isRunning={familySessions
            ? familySessions.some((session) => runningSessionIds.has(session.id))
            : runningSessionIds.has(node.session.id)}
          isUnread={unreadSessionIds.has(node.session.id)}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          subtitle={subtitle}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionFamilyItem
              key={child.session.id}
              node={child}
              depth={depth + 1}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              subtitle={subtitle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunningSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.agentRunning")}
      aria-label={t("sidebar.agentRunning")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path
            d="M21 12a9 9 0 1 1-3.8-7.4"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}

function UnreadSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.newActivity")}
      aria-label={t("sidebar.newSessionActivity")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "#0891b2",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
          <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
  );
}

/**
 * Compact per-project activity badges for the workspace selector dropdown items:
 * a spinning running icon + count and an unread dot + count. Renders nothing
 * when the project has no activity. Counts share the accent / unread colors of
 * the per-session indicators so the two stay visually consistent.
 */
/* eslint-disable-next-line @typescript-eslint/no-unused-vars */
function showProjectActivity(
  activity: { running: number; unread: number } | undefined,
  t: (key: string) => string,
): ReactNode {
  if (!activity || (activity.running === 0 && activity.unread === 0)) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, marginLeft: 6 }}>
      {activity.running > 0 && (
        <span
          title={t("sidebar.agentRunning")}
          aria-label={`${t("sidebar.agentRunning")} (${activity.running})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--accent)", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
            <g>
              <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
            </g>
          </svg>
          {activity.running}
        </span>
      )}
      {activity.unread > 0 && (
        <span
          title={t("sidebar.newSessionActivity")}
          aria-label={`${t("sidebar.newSessionActivity")} (${activity.unread})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#0891b2", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
          {activity.unread}
        </span>
      )}
    </span>
  );
}

function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  onDeleted,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
  isSubagentChild = false,
  subtitle,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  isSubagentChild?: boolean;
  /** Cross-project context; omitted inside the project tree where the group already names it. */
  subtitle?: string;
}) {
  const { locale, t } = useI18n();
  const [hovered, setHovered] = useState(false);
  // Coarse pointers have no hover: the "…" action menu must be permanently
  // visible there, otherwise rename/delete are unreachable on touch.
  const [touchMode, setTouchMode] = useState(false);
  // Downstream hook (extensions/desktop) may claim the row's context menu;
  // when it handles the event the built-in menu never opens.
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [treeFocused, setTreeFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // Select the whole name once the rename input is mounted (startRename's
  // immediate setTimeout can fire before the input exists).
  useEffect(() => {
    if (renaming) {
      const id = requestAnimationFrame(() => inputRef.current?.select());
      return () => cancelAnimationFrame(id);
    }
  }, [renaming]);

  useEffect(() => {
    setTouchMode(window.matchMedia?.("(hover: none)").matches ?? false);
  }, []);

  // A stored first message may be an SDK-expanded <skill> block; collapse it
  // back to the compact /skill:name args command the user typed before using
  // it as the auto-name fallback, mirroring MessageView's rendering.
  const displayFirstMessage = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  const title = session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12);

  const startRename = useCallback(() => {
    if (session.transient) return;
    setRenameValue(session.name ?? "");
    setRenaming(true);
  }, [session.name, session.transient]);

  const beginDeleteConfirmation = useCallback(() => {
    if (session.transient) return;
    setConfirmDelete(true);
  }, [session.transient]);

  const reportActionError = useCallback((message: string) => {
    appNotify.error({ message });
  }, []);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    // No-op when unchanged: the fallback title (first message / id) isn't a
    // real stored name, so don't persist it as one. (The rename input seeds
    // from the same collapsed displayFirstMessage, so an untouched rename of
    // a skill-invoked session stays a no-op instead of persisting raw XML.)
    if (renameValue === title || name === (session.name ?? "")) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      onRenamed?.();
    } catch (e) {
      reportActionError(t("sidebar.renameFailed", { error: e instanceof Error ? e.message : String(e) }));
    }
  }, [renameValue, session.id, session.name, onRenamed, reportActionError, t, title]);

  const performDelete = useCallback(async () => {
    if (session.transient) return;
    setConfirmDelete(false);
    setDeleting(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      onDeleted?.(session.id);
    } catch (e) {
      setDeleting(false);
      reportActionError(t("sidebar.deleteFailed", { error: e instanceof Error ? e.message : String(e) }));
    }
  }, [session.id, session.transient, onDeleted, reportActionError, t]);

  // "…" menu: fixed-position portal so the sidebar's overflow/backdrop-filter can't clip it
  const MENU_WIDTH = 190;
  // Desktop shell: the same actions as the DOM menu below, as a native popup.
  // `menuOpen` stays true while it is up so the trailing "…" button does not
  // swap back to the timestamp; `menuPos` stays null, so no DOM menu renders.
  const showNativeSessionMenu = useCallback(async (at: NativeMenuPoint): Promise<boolean> => {
    if (session.transient || !canUseNativeMenu()) return false;
    setMenuOpen(true);
    const shown = await showNativeMenu([
      { label: t("sidebar.rename"), onSelect: startRename },
      { label: t("sidebar.delete"), onSelect: beginDeleteConfirmation },
      { kind: "separator" },
      {
        label: `${formatRelativeTime(session.modified, locale)} · ${t("sidebar.messagesCount", { count: session.messageCount })}`,
        disabled: true,
      },
      ...((session.compactionCount ?? 0) > 0
        ? [{ label: t("sidebar.compactionCount", { count: session.compactionCount ?? 0 }), disabled: true }]
        : []),
      ...(session.worktreeBranch ? [{ label: session.worktreeBranch, disabled: true }] : []),
    ], at);
    setMenuOpen(false);
    return shown;
  }, [beginDeleteConfirmation, locale, session.compactionCount, session.messageCount, session.modified, session.transient, session.worktreeBranch, startRename, t]);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const handled = dispatchSessionRowContextMenu({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      clientX: e.clientX,
      clientY: e.clientY,
      refresh: () => { onRenamed?.(); },
    });
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Replace the webview's own context menu (Reload / Inspect) with the row's actions.
    if (isTauriDesktop() && !session.transient) {
      // Suppresses the webview menu (Reload / Inspect); the row actions open
      // natively only while native popups are on, otherwise via the "…" button.
      e.preventDefault();
      e.stopPropagation();
      void showNativeSessionMenu({ x: e.clientX, y: e.clientY });
    }
  }, [onRenamed, session.cwd, session.id, session.name, session.path, session.transient, showNativeSessionMenu]);

  const toggleMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (menuOpen) { setMenuOpen(false); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const openDomMenu = () => {
      const estHeight = 124;
      const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
      let top = rect.bottom + 4;
      if (top + estHeight > window.innerHeight - 8) top = rect.top - estHeight - 4;
      setMenuPos({ top, left });
      setMenuOpen(true);
    };
    if (canUseNativeMenu()) {
      void showNativeSessionMenu(menuPointBelow(e.currentTarget)).then((shown) => {
        if (!shown) openDomMenu();
      });
      return;
    }
    openDomMenu();
  }, [menuOpen, showNativeSessionMenu]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (menuButtonRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (ev: KeyboardEvent) => { if (ev.key === "Escape" && !isImeComposing(ev)) setMenuOpen(false); };
    const onScrollOrResize = () => setMenuOpen(false);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [menuOpen]);

  const handleDeleteConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void performDelete();
  }, [performDelete]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);


  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  return (
    <div
      className={`session-item${isSelected ? " is-selected" : ""}${isRunning ? " is-running" : ""}${isUnread ? " is-unread" : ""}`}
      data-sidebar-tree-row
      tabIndex={0}
      role="treeitem"
      aria-selected={isSelected}
      onBlur={() => setTreeFocused(false)}
      onClick={confirmDelete || renaming ? undefined : onClick}
      onKeyDown={(e) => handleSidebarTreeKeyDown(e, {
        activate: () => {
          if (!confirmDelete && !renaming) onClick();
        },
        expand: () => {
          if (hasChildren && collapsed) onToggleCollapse?.();
        },
        collapse: () => {
          if (hasChildren && !collapsed) onToggleCollapse?.();
        },
        rename: startRename,
        requestDelete: beginDeleteConfirmation,
      })}
      onContextMenu={confirmDelete || renaming ? undefined : handleContextMenu}
      onMouseEnter={() => {
        setHovered(true);
        if (!isRunning && !isSelected) prefetchSessionData(session.id);
      }}
      onPointerDown={() => {
        if (!isRunning && !isSelected) prefetchSessionData(session.id);
      }}
      onFocus={() => setTreeFocused(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: SESSION_LIST_ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: 11,
        paddingRight: 8,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "color-mix(in srgb, var(--danger) 6%, transparent)"
          : isSelected ? "var(--bg-selected)" : (hovered || treeFocused || menuOpen) ? "var(--bg-hover)" : "transparent",
        borderLeft: confirmDelete
          ? "2px solid var(--danger)"
          : isSelected ? "2px solid var(--accent)" : "2px solid transparent",
        transition: "background 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar.deleteSession", { title: title.slice(0, 22) + (title.length > 22 ? "…" : "") })}
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 26, padding: "0 9px",
                background: "var(--danger)", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              {t("sidebar.delete")}
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 26, padding: "0 9px",
                background: "var(--bg)", border: "var(--hairline) solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {t("sidebar.cancel")}
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return;
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "3px 8px",
            border: "var(--hairline) solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 26,
          }}
        />
      ) : (
        /* ── Normal view: single line — leading icon + title + "…" menu ── */
        <>
          {/* Leading icon: running / unread, falling back to the standard
              chat-bubble glyph for every session. Subagent child rows carry
              the robot glyph instead of the chat bubble. */}
          {isRunning ? (
            <RunningSessionIndicator />
          ) : isUnread ? (
            <UnreadSessionIndicator />
          ) : isSubagentChild ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <rect x="5" y="7" width="14" height="11" rx="2" />
              <path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
            </svg>
          ) : (
            <svg className="session-item-glyph" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
          )}
          <span
            className="session-item-title"
            title={subtitle ? `${title} · ${subtitle}` : title}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 13,
              fontWeight: 400,
              lineHeight: 1.4,
              color: "var(--text)",
            }}
          >
            {title}
          </span>
          {subtitle && (
            <span className="session-item-project" title={subtitle}>
              {subtitle}
            </span>
          )}

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={t(collapsed ? "sidebar.expandSubagents" : "sidebar.collapseSubagents")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          {/* Trailing slot: the row's last-activity time at rest, swapped in
              place for the "…" action button on hover (always the button on
              touch devices, which have no hover, and while its menu is open,
              since the pointer then sits on the portal). Transient runtime
              rows expose no disk-backed actions and have no reliable time.
              The slot keeps one fixed width so the title never reflows. */}
          {!session.transient && (
            <div
              className="session-item-trailing"
              style={{
                display: "flex", alignItems: "center", justifyContent: "flex-end",
                width: 28, height: 24, flexShrink: 0,
              }}
            >
              {hovered || treeFocused || touchMode || menuOpen ? (
                <button
                  ref={menuButtonRef}
                  onClick={toggleMenu}
                  title={t("sidebar.moreActions")}
                  aria-label={t("sidebar.moreActions")}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  className={`session-item-more${menuOpen ? " is-open" : ""}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="5" cy="12" r="1.7" />
                    <circle cx="12" cy="12" r="1.7" />
                    <circle cx="19" cy="12" r="1.7" />
                  </svg>
                </button>
              ) : (
                <span
                  className="session-item-time"
                  title={formatRelativeTime(session.modified, locale)}
                  style={{
                    fontSize: 11, lineHeight: 1, color: "var(--text-dim)",
                    whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
                    paddingRight: 2,
                  }}
                >
                  {formatCompactRelativeTime(session.modified, locale)}
                </span>
              )}
            </div>
          )}

          {menuOpen && menuPos && createPortal(
            <div
              ref={menuRef}
              className="native-popover app-menu session-item-menu"
              role="menu"
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "fixed", top: menuPos.top, left: menuPos.left,
                width: MENU_WIDTH, zIndex: 800, padding: 5,
                display: "flex", flexDirection: "column", gap: 1,
              }}
            >
              <button
                role="menuitem"
                onClick={() => { setMenuOpen(false); startRename(); }}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  width: "100%", height: 30, padding: "0 8px",
                  background: "transparent", border: 0, borderRadius: 7,
                  color: "var(--text)", cursor: "pointer",
                  fontSize: 13, textAlign: "left",
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
                {t("sidebar.rename")}
              </button>
              <button
                role="menuitem"
                className="is-danger"
                title={t("sidebar.deleteWithShiftClick")}
                onClick={(e) => {
                  setMenuOpen(false);
                  if (e.shiftKey) void performDelete();
                  else setConfirmDelete(true);
                }}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  width: "100%", height: 30, padding: "0 8px",
                  background: "transparent", border: 0, borderRadius: 7,
                  color: "var(--danger)", cursor: "pointer",
                  fontSize: 13, textAlign: "left",
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
                {t("sidebar.delete")}
              </button>
              <div style={{ height: 1, margin: "4px 3px", background: "var(--border)" }} />
              <div style={{ padding: "3px 8px 5px", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6 }}>
                <div title={session.created}>
                  {formatRelativeTime(session.modified, locale)} · {t("sidebar.messagesCount", { count: session.messageCount })}
                </div>
                {(session.compactionCount ?? 0) > 0 && (
                  <div>{t("sidebar.compactionCount", { count: session.compactionCount ?? 0 })}</div>
                )}
                {session.worktreeBranch && (
                  <div title={`Worktree: ${session.cwd}`} style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--accent)", minWidth: 0 }}>
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <line x1="6" y1="3" x2="6" y2="15" />
                      <circle cx="18" cy="6" r="3" />
                      <circle cx="6" cy="18" r="3" />
                      <path d="M18 9a9 9 0 0 1-9 9" />
                    </svg>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.worktreeBranch}</span>
                  </div>
                )}
              </div>
            </div>,
            document.body,
          )}

        </>
      )}
    </div>
  );
}
