"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { ProjectPicker, selectProjectDirectoryNative } from "./ProjectPicker";
import { AnimatedDropdown, PathLabel, displayCwd, getRecentProjects } from "./path-ui";
import { APP_PREF_KEYS, getPrefJson, removePref, setPrefJson } from "@/lib/app-prefs";
import { groupByProject } from "@/lib/project-group";
import { notifyDesktop } from "@/lib/desktop-notify";
import { revealItemInDirNative } from "@/lib/desktop-native";
import { isTauriDesktop } from "@/lib/desktop-updater";
import { getDesktopPlatform, type DesktopPlatform } from "@/lib/desktop-window";
import { useWindowDrag } from "./desktop";
interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null, projectRoot?: string | null) => void;
  onProjectsChange?: (projectRoots: string[]) => void;
  /** Window-chrome controls (theme + sidebar collapse) rendered at the top-right of the sidebar. */
  headerControls?: ReactNode;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  worktrees: WorktreeEntry[];
}

interface ProjectBranchMenuState {
  root: string;
  branches: string[];
  remoteBranches: string[];
  worktrees: WorktreeEntry[];
  loaded: boolean;
}

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

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}




interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

const MAX_VISIBLE_PROJECT_SESSIONS = 5;

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

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onProjectsChange, headerControls }: Props) {
  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  // On macOS the window has no native title bar — the traffic-light controls
  // float over whatever sits in the top-left corner, which is this sidebar's
  // header row. Push it down to clear them (see .session-sidebar-header--mac-inset).
  const [desktopPlatform, setDesktopPlatform] = useState<DesktopPlatform>(null);
  useEffect(() => {
    if (isTauriDesktop()) setDesktopPlatform(getDesktopPlatform());
  }, []);
  const windowDrag = useWindowDrag();
  const [wtFilter, setWtFilter] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");
  // Worktree switcher state
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtBranches, setWtBranches] = useState<string[]>([]);
  // Remote-only branch names (prefix stripped) for the switcher's branch list
  const [wtRemoteBranches, setWtRemoteBranches] = useState<string[]>([]);
  // False until the first branch-list response lands, so the "no other
  // branches" hint is not flashed while the list is still loading.
  const [wtBranchesLoaded, setWtBranchesLoaded] = useState(false);
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  // Branch currently being checked out (name shown dimmed with a spinner)
  const [wtSwitchingBranch, setWtSwitchingBranch] = useState<string | null>(null);
  const [wtFetching, setWtFetching] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<{ path: string; force: boolean } | null>(null);
  const [worktreeLoadingCwd, setWorktreeLoadingCwd] = useState<string | null>(null);
  // Ticked by the poll/focus effect below so the worktree row reflects
  // branches checked out outside pi (terminal, IDE) without a manual reload.
  const [wtPollTick, setWtPollTick] = useState(0);
  const wtDropdownRef = useRef<HTMLDivElement>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [expandedProjectSessions, setExpandedProjectSessions] = useState<Set<string>>(() => new Set());
  const [archivedProjectRoots, setArchivedProjectRoots] = useState<Set<string>>(() => {
    const stored = getPrefJson<unknown>(APP_PREF_KEYS.archivedProjects);
    return Array.isArray(stored)
      ? new Set(stored.filter((root): root is string => typeof root === "string"))
      : new Set();
  });
  const [projectMenu, setProjectMenu] = useState<{ root: string } | null>(null);
  const [projectMenuPos, setProjectMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [projectBranchMenu, setProjectBranchMenu] = useState<ProjectBranchMenuState | null>(null);
  const [projectBranchLoading, setProjectBranchLoading] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const sseAuthoritativeRef = useRef(false);
  // Overlay-style scrollbar: only visible while the list is actually scrolling.
  const listScrollHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.classList.add("is-scrolling");
    if (listScrollHideTimerRef.current) clearTimeout(listScrollHideTimerRef.current);
    listScrollHideTimerRef.current = setTimeout(() => {
      el.classList.remove("is-scrolling");
      listScrollHideTimerRef.current = null;
    }, 800);
  }, []);
  useEffect(() => () => {
    if (listScrollHideTimerRef.current) clearTimeout(listScrollHideTimerRef.current);
  }, []);

  const loadSessions = useCallback(async (showLoading = false) => {
    try {
      if (showLoading) setLoading(true);
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[] };
      setAllSessions(data.sessions);
      // Treat the fetched running set as an initial fallback only. Once the
      // live SSE stream is connected, a slow session-list fetch cannot overwrite it.
      if (!sseAuthoritativeRef.current) {
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      // Drop unread markers for sessions that no longer exist (e.g. deleted).
      const existingIds = new Set(data.sessions.map((s) => s.id));
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => existingIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch {
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst);
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
    // Live running status via SSE — no polling. The server pushes the current
    // set of running session ids whenever any session starts/stops working.
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      source?.close();
      source = new EventSource("/api/agent/running/events");
      source.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data) as { type?: string; runningSessionIds?: string[] };
          if (data.type === "running") {
            sseAuthoritativeRef.current = true;
            setRunningSessionIds(new Set(data.runningSessionIds ?? []));
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
  }, []);

  useEffect(() => {
    if (!projectMenu) return;
    const handler = (e: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenu(null);
        setProjectMenuPos(null);
        setProjectBranchMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [projectMenu]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const newlyRunning = [...runningSessionIds];

    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        newlyRunning.forEach((id) => next.delete(id));
        completedInBackground.forEach((id) => next.add(id));
        return next;
      });
    }
    if (completedInBackground.length > 0) {
      loadSessions(false);
      const sessionName = (id: string) => {
        const session = allSessions.find((item) => item.id === id);
        return session?.name || session?.firstMessage || id.slice(0, 8);
      };
      for (const id of completedInBackground) {
        void notifyDesktop({
          title: "Pi Agent",
          body: `Finished: ${sessionName(id)}`,
        });
      }
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId, loadSessions, allSessions]);

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

  /** Resolve the project root for a cwd from the freshest data available */
  const projectRootFor = useCallback((cwd: string | null): string | null => {
    if (!cwd) return null;
    if (worktreeState && worktreeState.forCwd === cwd) return worktreeState.projectRoot;
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => w.path === cwd)) return worktreeState.projectRoot;
    const match = allSessions.find((s) => s.cwd === cwd);
    return match?.projectRoot ?? cwd;
  }, [worktreeState, allSessions]);

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
  const lastNotifiedCwdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastNotifiedCwdRef.current === selectedCwd) return;
    lastNotifiedCwdRef.current = selectedCwd;
    onCwdChange?.(selectedCwd, projectRootFor(selectedCwd));
  }, [selectedCwd, onCwdChange, projectRootFor]);

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
  // Cwds already resolved once: background refetches (e.g. refreshKey bump on
  // agent end) stay silent for them, so the transient "checking worktrees"
  // header row doesn't flash and shove the session list down and back up.
  const checkedWorktreeCwdsRef = useRef<Set<string>>(new Set());
  useLayoutEffect(() => {
    if (!selectedCwd) {
      setWorktreeState(null);
      setWorktreeLoadingCwd(null);
      return;
    }
    let cancelled = false;
    if (!checkedWorktreeCwdsRef.current.has(selectedCwd)) {
      setWorktreeLoadingCwd(selectedCwd);
    }
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; isGit?: boolean; isTopLevel?: boolean; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        checkedWorktreeCwdsRef.current.add(selectedCwd);
        setWorktreeLoadingCwd(null);
        if (d.error || !d.projectRoot) {
          setWorktreeState(null);
          return;
        }
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: d.projectRoot,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          worktrees: d.worktrees ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) {
          setWorktreeLoadingCwd(null);
          setWorktreeState(null);
        }
      });
    return () => { cancelled = true; };
  }, [selectedCwd, wtRefreshKey, refreshKey, wtPollTick]);

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
    if (allSessions.length === 0 || skipInitialProjectSelection) return;

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
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone, recentProjects]);

  // Branch list for the switcher section (and the new-worktree datalist).
  // Loaded while the dropdown is open and on every poll tick, so branches
  // created or fetched elsewhere show up on the next open.
  const wtProjectRoot = worktreeState?.projectRoot ?? null;
  useEffect(() => {
    if (!wtDropdownOpen || !wtProjectRoot) return;
    let cancelled = false;
    fetch(`/api/worktrees?cwd=${encodeURIComponent(wtProjectRoot)}&branches=1`)
      .then((r) => r.json())
      .then((d: { branches?: string[]; remoteBranches?: string[] }) => {
        if (cancelled) return;
        setWtBranchesLoaded(true);
        setWtBranches(Array.isArray(d.branches) ? d.branches : []);
        setWtRemoteBranches(Array.isArray(d.remoteBranches) ? d.remoteBranches : []);
      })
      .catch(() => {
        if (!cancelled) {
          setWtBranches([]);
          setWtRemoteBranches([]);
        }
      });
    return () => { cancelled = true; };
  }, [wtDropdownOpen, wtProjectRoot, wtPollTick]);

  // The worktree matching selectedCwd, falling back to the main worktree when
  // worktreeState hasn't caught up to selectedCwd yet (e.g. right after
  // creating/switching to a worktree, before the next refresh lands) — same
  // fallback the switcher dropdown itself uses to stay correct through that
  // race, instead of comparing raw paths that may not (yet) match anything.
  const currentWt = worktreeState?.worktrees.find((w) => w.path === selectedCwd)
    ?? worktreeState?.worktrees.find((w) => w.isMain)
    ?? null;

  const handleSwitchBranch = useCallback(async (branch: string) => {
    if (!worktreeState || wtBusy || wtSwitchingBranch) return;
    // git refuses to check out a branch that another worktree already holds —
    // jump to that worktree instead; that is what the user means anyway.
    const holder = worktreeState.worktrees.find((w) => w.branch === branch && w.path !== currentWt?.path);
    if (holder) {
      setSelectedCwd(holder.path);
      setWtDropdownOpen(false);
      setWtError(null);
      setWtFilter("");
      return;
    }
    if (currentWt?.branch === branch) return;
    const cwd = currentWt?.path ?? selectedCwd ?? worktreeState.projectRoot;
    setWtSwitchingBranch(branch);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, branch }),
      });
      const data = await res.json().catch(() => ({})) as { branch?: string; error?: string };
      if (!res.ok || data.error || !data.branch) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtDropdownOpen(false);
      setWtRefreshKey((k) => k + 1);
      // The checkout's contents just changed wholesale — refresh the
      // session rows (worktreeBranch subtitles) alongside the header.
      void loadSessions(false);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtSwitchingBranch(null);
    }
  }, [worktreeState, wtBusy, wtSwitchingBranch, currentWt, selectedCwd, loadSessions]);

  const openProjectBranchMenu = useCallback(async (projectRoot: string) => {
    setProjectBranchMenu({ root: projectRoot, branches: [], remoteBranches: [], worktrees: [], loaded: false });
    setProjectBranchLoading(true);
    try {
      const res = await fetch(`/api/worktrees?cwd=${encodeURIComponent(projectRoot)}&branches=1`);
      const data = await res.json().catch(() => ({})) as {
        projectRoot?: string;
        branches?: string[];
        remoteBranches?: string[];
        worktrees?: WorktreeEntry[];
      };
      if (!res.ok || data.projectRoot !== projectRoot) throw new Error(`HTTP ${res.status}`);
      setProjectBranchMenu((prev) => prev?.root === projectRoot ? {
        root: projectRoot,
        branches: Array.isArray(data.branches) ? data.branches : [],
        remoteBranches: Array.isArray(data.remoteBranches) ? data.remoteBranches : [],
        worktrees: Array.isArray(data.worktrees) ? data.worktrees : [],
        loaded: true,
      } : prev);
    } catch {
      setProjectBranchMenu((prev) => prev?.root === projectRoot ? {
        root: projectRoot, branches: [], remoteBranches: [], worktrees: [], loaded: true,
      } : prev);
    } finally {
      setProjectBranchLoading(false);
    }
  }, []);

  const handleSwitchProjectBranch = useCallback(async (projectRoot: string, branch: string) => {
    if (wtSwitchingBranch) return;
    const branchData = projectBranchMenu?.root === projectRoot ? projectBranchMenu : null;
    const checkout = branchData?.worktrees.find((w) => w.path === selectedCwd)
      ?? branchData?.worktrees.find((w) => w.isMain)
      ?? null;
    const holder = branchData?.worktrees.find((w) => w.branch === branch && w.path !== checkout?.path);
    if (holder) {
      setSelectedCwd(holder.path);
      setProjectMenu(null);
      setProjectMenuPos(null);
      setProjectBranchMenu(null);
      return;
    }
    if (checkout?.branch === branch) {
      setSelectedCwd(checkout.path);
      setProjectMenu(null);
      setProjectMenuPos(null);
      setProjectBranchMenu(null);
      return;
    }

    const cwd = checkout?.path ?? projectRoot;
    setWtSwitchingBranch(branch);
    try {
      const res = await fetch("/api/worktrees", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, branch }),
      });
      const data = await res.json().catch(() => ({})) as { branch?: string; error?: string };
      if (!res.ok || data.error || !data.branch) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setSelectedCwd(cwd);
      setProjectMenu(null);
      setProjectMenuPos(null);
      setProjectBranchMenu(null);
      setWtRefreshKey((k) => k + 1);
      void loadSessions(false);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtSwitchingBranch(null);
    }
  }, [projectBranchMenu, selectedCwd, wtSwitchingBranch, loadSessions]);

  const handleFetchBranches = useCallback(async () => {
    if (!worktreeState || wtFetching) return;
    setWtFetching(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot }),
      });
      const data = await res.json().catch(() => ({})) as { branches?: string[]; remoteBranches?: string[]; error?: string };
      if (!res.ok || data.error) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtBranches(Array.isArray(data.branches) ? data.branches : []);
      setWtRemoteBranches(Array.isArray(data.remoteBranches) ? data.remoteBranches : []);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtFetching(false);
    }
  }, [worktreeState, wtFetching]);

  const handleCreateWorktree = useCallback(async () => {
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !worktreeState) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtNewOpen(false);
      setWtNewBranch("");
      setWtDropdownOpen(false);
      // Optimistically register the new worktree so projectRootFor() resolves
      // it to the main repo before the refetch lands (keeps AppShell from
      // treating the new cwd as a different project).
      setWorktreeState((prev) => prev ? {
        ...prev,
        forCwd: data.path!,
        worktrees: [...prev.worktrees, { path: data.path!, branch, isMain: false }],
      } : prev);
      setSelectedCwd(data.path);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, worktreeState]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean) => {
    if (!worktreeState || wtBusy) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — escalate the confirm row to a force removal
          setWtConfirmRemove({ path, force: true });
          return;
        }
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtConfirmRemove(null);
      if (selectedCwd === path) setSelectedCwd(worktreeState.projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [worktreeState, wtBusy, selectedCwd]);

  // Close the worktree dropdown on outside click (the project picker owns its own)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wtDropdownRef.current && !wtDropdownRef.current.contains(e.target as Node)) {
        setWtDropdownOpen(false);
        setWtNewOpen(false);
        setWtNewBranch("");
        setWtError(null);
        setWtConfirmRemove(null);
        setWtFilter("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback((s: SessionInfo) => {
    if (s.cwd) setSelectedCwd(s.cwd);
    onSelectSession(s);
  }, [onSelectSession]);

  const handleNewSession = useCallback((cwdOverride?: string) => {
    const cwd = cwdOverride ?? selectedCwd;
    if (!cwd) return;
    // Creating a session is also the activation gesture for an archived
    // project. This keeps the archive list useful without a second step.
    const projectRoot = projectRootFor(cwd) ?? cwd;
    if (archivedProjectRoots.has(projectRoot)) {
      setArchivedProjectRoots((prev) => {
        const next = new Set(prev);
        next.delete(projectRoot);
        return next;
      });
    }
    if (cwd !== selectedCwd) setSelectedCwd(cwd);
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, cwd);
  }, [selectedCwd, archivedProjectRoots, onNewSession, projectRootFor]);

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
    setProjectMenu(null);
    setProjectMenuPos(null);
  }, []);

  const openProjectMenu = useCallback((e: React.MouseEvent<HTMLButtonElement>, projectRoot: string) => {
    e.stopPropagation();
    if (projectMenu?.root === projectRoot) {
      setProjectMenu(null);
      setProjectMenuPos(null);
      setProjectBranchMenu(null);
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
  }, [projectMenu]);

  // Phase A: project tree — groups sessions by project root. Sorting is
  const trimmedSessionQuery = sessionQuery.trim().toLowerCase();
  const searchedSessions = trimmedSessionQuery
    ? allSessions.filter((session) =>
        (session.name ?? "").toLowerCase().includes(trimmedSessionQuery)
        || session.firstMessage.toLowerCase().includes(trimmedSessionQuery))
    : allSessions;
  const allProjects = groupByProject(searchedSessions, { runningIds: runningSessionIds, unreadIds: unreadSessionIds });
  const activeProjects = allProjects.filter((group) => !archivedProjectRoots.has(group.projectRoot));
  useEffect(() => {
    const projectRoots = activeProjects.map((group) => group.projectRoot);
    onProjectsChange?.(projectRoots);
  }, [activeProjects, onProjectsChange]);
  // Sessions of every worktree in the selected project are shown together
  const selectedProject = projectRootFor(selectedCwd);
  const showWorktreeSwitcher = Boolean(
    worktreeState?.isGit
    && worktreeState.isTopLevel
    && selectedCwd
    && selectedProject === worktreeState.projectRoot
  );
  // Only show a guide row when worktrees are actually reachable (a git repo,
  // just not checked out at its top level) — a non-git directory has no
  // worktree feature to point at, so stay silent instead of showing an inert
  // "not available" placeholder.
  const worktreeGuide = selectedCwd
    && worktreeState
    && selectedProject === worktreeState.projectRoot
    && !showWorktreeSwitcher
    && worktreeState.isGit
    ? {
        label: t("sidebar.openRepoRoot"),
        title: t("sidebar.openRepoRootTitle"),
        onClick: () => setSelectedCwd(worktreeState.projectRoot),
      }
    : null;
  const worktreeLoading = Boolean(selectedCwd && worktreeLoadingCwd === selectedCwd);
  const inactiveWorktreeSelector = worktreeGuide
    ?? (worktreeLoading && !showWorktreeSwitcher
      ? {
           label: t("sidebar.worktrees"),
           title: t("sidebar.checkingWorktrees"),
           onClick: undefined,
        }
      : null);
  // The selected project and its branch are represented by the project tree
  // below. Keep the old header rows mounted only as an implementation
  // fallback, but do not show the duplicated directory/worktree summary.
  const showLegacyHeaderProjectRows = false;

  const renderProjectGroup = (group: ReturnType<typeof groupByProject>[number]) => {
    const isCollapsed = !trimmedSessionQuery && collapsedProjects.has(group.projectRoot);
    const isActive = group.projectRoot === selectedProject;
    const runningCount = group.runningIds.size;
    const unreadCount = group.unreadIds.size;
    const groupTree = buildSessionTree(group.sessions);
    const showSessionOverflow = groupTree.length > MAX_VISIBLE_PROJECT_SESSIONS;
    const isSessionOverflowExpanded = Boolean(trimmedSessionQuery) || expandedProjectSessions.has(group.projectRoot);
    let visibleGroupTree = isSessionOverflowExpanded
      ? groupTree
      : groupTree.slice(0, MAX_VISIBLE_PROJECT_SESSIONS);
    // Keep the selected session reachable even when it is older than the
    // collapsed preview window.
    if (!isSessionOverflowExpanded && selectedSessionId) {
      const selectedRoot = groupTree.find((node) => treeContainsSession(node, selectedSessionId));
      if (selectedRoot && !visibleGroupTree.includes(selectedRoot)) {
        visibleGroupTree = [...visibleGroupTree.slice(0, -1), selectedRoot];
      }
    }
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
      if (!isActive) setSelectedCwd(group.projectRoot);
    };

    return (
      <div key={group.projectRoot} className={`sidebar-project-tree-group${isCollapsed ? " is-collapsed" : ""}${isActive ? " is-active" : ""}`}>
        <div className="sidebar-project-tree-row">
          <button
            type="button"
            className="sidebar-project-tree-row-main"
            onClick={toggleCollapse}
            aria-expanded={!isCollapsed}
            title={group.projectRoot}
          >
            <span className="sidebar-project-tree-folder" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                {isCollapsed ? (
                  <path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5Z" />
                ) : (
                  <path d="M3.5 7.5h6l2 2H21l-2 9.5H5a1.5 1.5 0 0 1-1.5-1.5Z" />
                )}
              </svg>
            </span>
            <span className="sidebar-project-tree-name">{group.displayName}</span>
            {branchSubtitle && (
              <span className="sidebar-project-tree-branch" title={branchSubtitle}>
                {branchSubtitle}
              </span>
            )}
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
          </button>
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
              aria-expanded={projectMenu?.root === group.projectRoot}
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
            {visibleGroupTree.map((node) => (
              <SessionTreeItem
                key={node.session.id}
                node={node}
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
            ))}
            {showSessionOverflow && (
              <button
                type="button"
                className="sidebar-project-tree-show-more"
                onClick={() => setExpandedProjectSessions((prev) => {
                  const next = new Set(prev);
                  if (next.has(group.projectRoot)) next.delete(group.projectRoot);
                  else next.add(group.projectRoot);
                  return next;
                })}
              >
                {isSessionOverflowExpanded ? t("sidebar.showLessSessions") : t("sidebar.showMoreSessions")}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="session-sidebar" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div
        className={`session-sidebar-header${desktopPlatform === "macos" ? " session-sidebar-header--mac-inset" : ""}`}
        data-tauri-drag-region={desktopPlatform ? true : undefined}
        {...windowDrag}
        style={{
          padding: "12px 10px 10px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {/* Window-chrome controls row: right-aligned (theme + collapse); on macOS
            the traffic lights share this row's left side. */}
        {headerControls && (
          <div className="sidebar-controls-row">
            {headerControls}
          </div>
        )}

        {/* Row 1: New Session — full-width flat row, Claude Desktop style */}
        <button
          className="sidebar-header-row sidebar-new-row"
          onClick={() => handleNewSession()}
          disabled={!selectedCwd}
          title={selectedCwd ? `${t("sidebar.newSessionTitle", { path: selectedCwd })} (⌘/Ctrl+N)` : t("sidebar.selectProject")}
        >
          <span className="sidebar-new-plus" aria-hidden="true">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="1.5" x2="6" y2="10.5" />
              <line x1="1.5" y1="6" x2="10.5" y2="6" />
            </svg>
          </span>
          {t("sidebar.newChat")}
        </button>

        {/* Row 2: current folder — flat row */}
        <div className="sidebar-folder-row" data-no-drag style={{ display: showLegacyHeaderProjectRows ? "flex" : "none", alignItems: "center", gap: 2 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <ProjectPicker
              recentProjects={recentProjects}
              selectedCwd={selectedCwd}
              selectedProject={selectedProject}
              homeDir={homeDir}
              onSelectCwd={activateProject}
              variant="block"
            />
          </div>
        </div>

        {/* Worktree switcher — shown only for git projects at a checkout top
            level (repo subdirs keep their own project identity, so switching
            from them would jump projects). Rendered whenever the selected cwd
            belongs to the loaded project (not just when forCwd matches), so
            switching between worktrees of one project keeps the row mounted
            instead of flickering while data refetches: all worktrees of a
            project share the same list anyway. */}
        {showLegacyHeaderProjectRows && showWorktreeSwitcher && (() => {
          if (!worktreeState) return null;
          const showWtFilter = worktreeState.worktrees.length >= 8;
          const visibleWorktrees = showWtFilter && wtFilter.trim()
            ? worktreeState.worktrees.filter((w) =>
                (w.branch ?? displayCwd(w.path, homeDir)).toLowerCase().includes(wtFilter.trim().toLowerCase()))
            : worktreeState.worktrees;
          return (
            <div ref={wtDropdownRef} data-no-drag style={{ position: "relative" }}>
              <button
                className="sidebar-header-row"
                onClick={() => {
                  setWtDropdownOpen((v) => !v);
                  // Opening should show the branch state as of now, not as of
                  // the last poll — the branch may have been switched outside pi.
                  if (!wtDropdownOpen) setWtRefreshKey((k) => k + 1);
                }}
                 title={currentWt ? t("sidebar.switchWorktreeTitle", { path: currentWt.path }) : t("sidebar.switchWorktree")}
                style={{ background: wtDropdownOpen ? "var(--bg-hover)" : undefined }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: currentWt && !currentWt.isMain ? "var(--accent)" : "var(--text-muted)" }}>
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <PathLabel
                  text={currentWt ? (currentWt.branch ?? displayCwd(currentWt.path, homeDir)) : "…"}
                  style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text)" }}
                />
                {currentWt?.isMain && (
                   <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>
                )}
                {worktreeState.worktrees.length > 1 && (
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>
                    {worktreeState.worktrees.length}
                  </span>
                )}
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <polyline points="2 3.5 5 6.5 8 3.5" />
                </svg>
              </button>

              <AnimatedDropdown
                className="native-popover"
                open={wtDropdownOpen}
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  right: 0,
                  zIndex: 100,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                  overflow: "hidden",
                }}
              >
                  {showWtFilter && (
                    <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                      <input
                        value={wtFilter}
                        onChange={(e) => setWtFilter(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setWtFilter("");
                            setWtDropdownOpen(false);
                          }
                        }}
                        placeholder={t("sidebar.filterWorktrees")}
                        autoFocus
                        style={{
                          width: "100%",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          padding: "5px 8px",
                          border: "1px solid var(--border)",
                          borderRadius: 5,
                          outline: "none",
                          background: "var(--bg)",
                          color: "var(--text)",
                          boxSizing: "border-box",
                        }}
                      />
                    </div>
                  )}
                  <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
                    {visibleWorktrees.map((wt) => {
                      const isCurrent = wt.path === selectedCwd || (wt.isMain && !worktreeState.worktrees.some((w) => w.path === selectedCwd));
                      if (wtConfirmRemove?.path === wt.path) {
                        const isForce = wtConfirmRemove.force;
                        return (
                          <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "color-mix(in srgb, var(--danger) 6%, transparent)" }}>
                            <span style={{ flex: 1, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {isForce ? t("sidebar.forceRemoveCheckout") : t("sidebar.confirmRemoveWorktree")}
                            </span>
                            <button
                              onClick={() => void handleRemoveWorktree(wt.path, isForce)}
                              disabled={wtBusy}
                              style={{ padding: "3px 9px", background: "var(--danger)", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                            >
                              {isForce ? t("sidebar.force") : t("i18n.remove")}
                            </button>
                            <button
                              onClick={() => setWtConfirmRemove(null)}
                              style={{ padding: "3px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
                            >
                              {t("sidebar.cancel")}
                            </button>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={wt.path}
                          className="wt-row"
                          style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}
                        >
                          <button
                            onClick={() => {
                              setSelectedCwd(wt.path);
                              setWtDropdownOpen(false);
                              setWtError(null);
                              setWtFilter("");
                            }}
                            title={wt.path}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              display: "flex",
                              alignItems: "center",
                              gap: 7,
                              padding: "8px 10px",
                              background: "var(--bg)",
                              border: "none",
                              color: isCurrent ? "var(--text)" : "var(--text-muted)",
                              cursor: "pointer",
                              textAlign: "left",
                              fontSize: 11,
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {isCurrent ? (
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                <polyline points="1.5 5 4 7.5 8.5 2.5" />
                              </svg>
                            ) : (
                              <span style={{ width: 10, flexShrink: 0 }} />
                            )}
                            <PathLabel text={wt.branch ?? displayCwd(wt.path, homeDir)} style={{ flex: 1 }} />
                            {wt.isMain && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>}
                          </button>
                          {isTauriDesktop() && (
                            <button
                              type="button"
                              onClick={() => { void revealItemInDirNative(wt.path); }}
                              title={t("sidebar.revealWorktree")}
                              style={{
                                display: "flex", alignItems: "center", justifyContent: "center",
                                width: 28, height: 28, padding: 0, marginRight: 2,
                                background: "none", border: "none",
                                color: "var(--text-dim)", cursor: "pointer",
                                borderRadius: 5, flexShrink: 0,
                              }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                              </svg>
                            </button>
                          )}
                          {!wt.isMain && (
                            <button
                              onClick={() => { setWtError(null); setWtConfirmRemove({ path: wt.path, force: false }); }}
                              disabled={wtBusy}
                               title={t("sidebar.removeWorktreeTitle", { path: wt.path })}
                              style={{
                                display: "flex", alignItems: "center", justifyContent: "center",
                                width: 34, height: 28, padding: 0, marginRight: 4,
                                background: "none", border: "none",
                                color: "var(--text-dim)", cursor: "pointer",
                                borderRadius: 5, flexShrink: 0,
                                transition: "color 0.12s, background 0.12s",
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--danger)"; e.currentTarget.style.background = "color-mix(in srgb, var(--danger) 8%, transparent)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                <path d="M10 11v6M14 11v6" />
                                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                              </svg>
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {showWtFilter && visibleWorktrees.length === 0 && wtFilter.trim() && (
                      <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingWorktrees")}</div>
                    )}
                  </div>

                  {/* Branches of the current checkout — switch in place without
                      creating a worktree. Hidden while the new-worktree form is
                      open so the dropdown stays focused on one task. */}
                  {!wtNewOpen && (() => {
                    const currentBranch = currentWt?.branch ?? null;
                    const branchRows = [
                      ...wtBranches.map((name) => ({ name, remote: false })),
                      ...wtRemoteBranches.map((name) => ({ name, remote: true })),
                    ];
                    return (
                      <div style={{ borderTop: "1px solid var(--border)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 8px 3px" }}>
                          <span style={{ flex: 1, fontSize: 10, fontWeight: 600, letterSpacing: "0.03em", color: "var(--text-dim)" }}>{t("sidebar.switchBranch")}</span>
                          <button
                            type="button"
                            onClick={() => { void handleFetchBranches(); }}
                            disabled={wtFetching}
                            title={t("sidebar.fetchBranchesTitle")}
                            style={{
                              display: "flex", alignItems: "center", justifyContent: "center",
                              width: 22, height: 20, padding: 0,
                              background: "none", border: "none",
                              color: wtFetching ? "var(--accent)" : "var(--text-dim)",
                              cursor: "pointer", borderRadius: 4, flexShrink: 0,
                            }}
                          >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={wtFetching ? { animation: "spin 0.9s linear infinite" } : undefined}>
                              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                              <polyline points="21 3 21 9 15 9" />
                            </svg>
                          </button>
                        </div>
                        <div style={{ maxHeight: "min(28vh, 200px)", overflowY: "auto" }}>
                          {wtBranchesLoaded && branchRows.length === 0 && (
                            <div style={{ padding: "3px 10px 8px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noOtherBranches")}</div>
                          )}
                          {branchRows.map(({ name, remote }) => {
                            const isCurrent = name === currentBranch;
                            const holder = worktreeState.worktrees.find((w) => w.branch === name && w.path !== selectedCwd);
                            const switching = wtSwitchingBranch === name;
                            return (
                              <button
                                key={name}
                                onClick={() => { void handleSwitchBranch(name); }}
                                disabled={wtSwitchingBranch !== null}
                                title={
                                  holder ? t("sidebar.branchInWorktreeTitle", { branch: name })
                                    : remote ? t("sidebar.branchRemoteTitle")
                                      : t("sidebar.switchBranchTitle", { branch: name })
                                }
                                style={{
                                  display: "flex", alignItems: "center", gap: 7,
                                  width: "100%", padding: "6px 10px",
                                  background: isCurrent ? "var(--bg-hover)" : "none",
                                  border: "none",
                                  color: isCurrent ? "var(--text)" : "var(--text-muted)",
                                  cursor: "pointer", textAlign: "left",
                                  fontSize: 11, fontFamily: "var(--font-mono)",
                                  opacity: switching ? 0.55 : 1,
                                }}
                              >
                                {isCurrent ? (
                                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                    <polyline points="1.5 5 4 7.5 8.5 2.5" />
                                  </svg>
                                ) : (
                                  <span style={{ width: 10, flexShrink: 0 }} />
                                )}
                                <PathLabel text={name} style={{ flex: 1 }} />
                                {holder && (
                                  <span title={holder.path} style={{ flexShrink: 0, display: "flex", alignItems: "center", color: "var(--text-dim)" }}>
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <line x1="6" y1="3" x2="6" y2="15" />
                                      <circle cx="18" cy="6" r="3" />
                                      <circle cx="6" cy="18" r="3" />
                                      <path d="M18 9a9 9 0 0 1-9 9" />
                                    </svg>
                                  </span>
                                )}
                                {remote && !holder && (
                                  <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 9.5 }}>{t("sidebar.remoteBranchTag")}</span>
                                )}
                                {switching && (
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0, animation: "spin 0.8s linear infinite" }}>
                                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                                  </svg>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  {!wtNewOpen ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setWtNewOpen(true);
                        setWtError(null);
                        setTimeout(() => wtNewInputRef.current?.focus(), 0);
                      }}
                      title={t("sidebar.createWorktreeTitle")}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        width: "100%",
                        padding: "8px 10px",
                        background: "none",
                        border: "none",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 11,
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                        <line x1="5" y1="1" x2="5" y2="9" />
                        <line x1="1" y1="5" x2="9" y2="5" />
                      </svg>
                       <span>{t("sidebar.newWorktree")}</span>
                    </button>
                  ) : (
                    <div style={{ padding: "6px 8px" }}>
                      <input
                        ref={wtNewInputRef}
                        value={wtNewBranch}
                        list="pi-worktree-branches"
                        onChange={(e) => {
                          setWtNewBranch(e.target.value);
                          setWtError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleCreateWorktree();
                          }
                          if (e.key === "Escape") {
                            setWtNewOpen(false);
                            setWtNewBranch("");
                            setWtError(null);
                          }
                        }}
                         placeholder={t("sidebar.branchName")}
                        style={{
                          width: "100%",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          padding: "5px 8px",
                          border: "1px solid var(--accent)",
                          borderRadius: 5,
                          outline: "none",
                          background: "var(--bg)",
                          color: "var(--text)",
                          boxSizing: "border-box",
                        }}
                      />
                      <datalist id="pi-worktree-branches">
                        {wtBranches.map((branch) => (
                          <option key={branch} value={branch} />
                        ))}
                      </datalist>
                      {wtBranches.length > 0 && (
                        <div style={{ marginTop: 5, maxHeight: 96, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                          {wtBranches.slice(0, 8).map((branch) => (
                            <button
                              key={branch}
                              type="button"
                              onClick={() => setWtNewBranch(branch)}
                              style={{
                                textAlign: "left",
                                padding: "3px 6px",
                                border: "none",
                                borderRadius: 4,
                                background: branch === wtNewBranch ? "var(--bg-selected)" : "transparent",
                                color: "var(--text-muted)",
                                fontFamily: "var(--font-mono)",
                                fontSize: 10,
                                cursor: "pointer",
                              }}
                            >
                              {branch}
                            </button>
                          ))}
                        </div>
                      )}
                      <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                        <button
                          onClick={() => void handleCreateWorktree()}
                          disabled={wtBusy || !wtNewBranch.trim()}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--accent)",
                            border: "none",
                            borderRadius: 5,
                            color: "var(--accent-contrast)",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: wtBusy || !wtNewBranch.trim() ? "not-allowed" : "pointer",
                            opacity: wtBusy || !wtNewBranch.trim() ? 0.65 : 1,
                          }}
                        >
                           {wtBusy ? t("sidebar.creating") : t("sidebar.create")}
                        </button>
                        <button
                          onClick={() => { setWtNewOpen(false); setWtNewBranch(""); setWtError(null); }}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--bg-hover)",
                            border: "1px solid var(--border)",
                            borderRadius: 5,
                            color: "var(--text-muted)",
                            fontSize: 11,
                            cursor: "pointer",
                          }}
                        >
                           {t("sidebar.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                  {wtError && (
                    <div style={{
                      padding: "5px 10px 8px",
                      color: "#dc2626",
                      fontSize: 11,
                      lineHeight: 1.35,
                      overflowWrap: "anywhere",
                    }}>
                      {wtError}
                    </div>
                  )}
              </AnimatedDropdown>
            </div>
          );
        })()}
        {showLegacyHeaderProjectRows && inactiveWorktreeSelector && (
          <button
            type="button"
            className="sidebar-header-row"
            aria-disabled={inactiveWorktreeSelector.onClick ? undefined : "true"}
            tabIndex={inactiveWorktreeSelector.onClick ? undefined : -1}
            onClick={inactiveWorktreeSelector.onClick}
            title={inactiveWorktreeSelector.title}
            style={inactiveWorktreeSelector.onClick
              ? { color: "var(--text-muted)" }
              : { color: "var(--text-dim)", cursor: "default", opacity: 0.82 }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11.5 }}>{inactiveWorktreeSelector.label}</span>
          </button>
        )}
      </div>
      {/* Session search — keeps the original sidebar search styling and
          narrows the project tree to matching titles / first messages. */}
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
            if (e.key === "Escape") {
              e.stopPropagation();
              if (sessionQuery) setSessionQuery("");
              else e.currentTarget.blur();
            }
          }}
          placeholder={t("sidebar.searchSessions")}
          aria-label={t("sidebar.searchSessions")}
        />
        {sessionQuery && (
          <button
            type="button"
            className="sidebar-search-clear"
            onClick={() => setSessionQuery("")}
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
      {/* Project tree (Codex-style) — replaces the old CHATS/FILES tabs. Every
          project is rendered as a flat row whose chats nest directly beneath.
          Clicking a project header toggles collapse; the ⋯ menu offers sort
          and collapse/expand-all; the + button opens the project picker to
          add a new project. The FileExplorer has moved to the right panel. */}
      {allProjects.length === 0 ? (
        <div className="sidebar-project-tree-empty">
          {loading
            ? t("sidebar.loading")
            : trimmedSessionQuery
              ? t("sidebar.noMatchingSessions")
              : t("sidebar.noProjects")}
        </div>
      ) : (
        <div className="sidebar-project-tree" onScroll={handleListScroll}>
          <div className="sidebar-project-tree-header">
            <span className="sidebar-project-tree-title">{t("sidebar.projects")}</span>
            <div className="sidebar-project-tree-tools">
              <button
                className="sidebar-project-tree-menu"
                title={t("sidebar.moreActions")}
                aria-label={t("sidebar.moreActions")}
                onClick={() => {
                  if (collapsedProjects.size === 0) {
                    setCollapsedProjects(new Set(allProjects.map((g) => g.projectRoot)));
                  } else {
                    setCollapsedProjects(new Set());
                  }
                }}
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
          {activeProjects.map((group) => renderProjectGroup(group))}
        </div>
      )}
      {projectMenu && projectMenuPos && createPortal(
        <div
          ref={projectMenuRef}
          className="sidebar-project-context-menu native-popover"
          style={{ top: projectMenuPos.top, left: projectMenuPos.left, maxHeight: "min(70vh, 420px)", overflowY: "auto" }}
          role="menu"
        >
          {!projectBranchMenu ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => void openProjectBranchMenu(projectMenu.root)}
              >
                {t("sidebar.switchBranch")}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => archiveProject(projectMenu.root)}
              >
                {t("sidebar.archiveProject")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                className="sidebar-project-context-menu-back"
                onClick={() => setProjectBranchMenu(null)}
              >
                <span aria-hidden="true">‹</span> {t("sidebar.moreActions")}
              </button>
              <div className="sidebar-project-context-menu-heading">{t("sidebar.switchBranch")}</div>
              {projectBranchLoading && projectBranchMenu.root === projectMenu.root && (
                <div className="sidebar-project-context-menu-hint">…</div>
              )}
              {projectBranchMenu.loaded && projectBranchMenu.root === projectMenu.root && (
                <>
                  {[...projectBranchMenu.branches.map((name) => ({ name, remote: false })),
                    ...projectBranchMenu.remoteBranches.map((name) => ({ name, remote: true }))]
                    .map(({ name, remote }) => {
                      const checkout = projectBranchMenu.worktrees.find((w) => w.path === selectedCwd)
                        ?? projectBranchMenu.worktrees.find((w) => w.isMain);
                      const isCurrent = checkout?.branch === name;
                      const holder = projectBranchMenu.worktrees.find((w) => w.branch === name && w.path !== checkout?.path);
                      const switching = wtSwitchingBranch === name;
                      return (
                        <button
                          key={`${remote ? "remote:" : "local:"}${name}`}
                          type="button"
                          role="menuitem"
                          disabled={wtSwitchingBranch !== null}
                          onClick={() => void handleSwitchProjectBranch(projectMenu.root, name)}
                          title={holder
                            ? t("sidebar.branchInWorktreeTitle", { branch: name })
                            : remote
                              ? t("sidebar.branchRemoteTitle")
                              : t("sidebar.switchBranchTitle", { branch: name })}
                        >
                          <span className="sidebar-project-context-menu-branch-mark" aria-hidden="true">
                            {isCurrent ? "✓" : ""}
                          </span>
                          <span>{name}</span>
                          {holder && <span className="sidebar-project-context-menu-branch-tag">worktree</span>}
                          {remote && !holder && <span className="sidebar-project-context-menu-branch-tag">{t("sidebar.remoteBranchTag")}</span>}
                          {switching && <span className="sidebar-project-context-menu-branch-spinner" aria-hidden="true">↻</span>}
                        </button>
                      );
                    })}
                  {projectBranchMenu.branches.length === 0 && projectBranchMenu.remoteBranches.length === 0 && (
                    <div className="sidebar-project-context-menu-hint">{t("sidebar.noOtherBranches")}</div>
                  )}
                </>
              )}
            </>
          )}
        </div>,
        document.body,
      )}
      {projectPickerOpen && (
        <div className="project-picker-modal-overlay" role="dialog" aria-modal="true" onClick={() => setProjectPickerOpen(false)}>
          <div className="project-picker-modal-shell" onClick={(e) => e.stopPropagation()}>
            <ProjectPicker
              recentProjects={recentProjects}
              selectedCwd={selectedCwdProp ?? null}
              selectedProject={selectedProject}
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

function SessionTreeItem({
  node,
  depth = 0,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
}: {
  node: SessionTreeNode;
  depth?: number;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
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
          isSelected={node.session.id === selectedSessionId}
          isRunning={runningSessionIds.has(node.session.id)}
          isUnread={unreadSessionIds.has(node.session.id)}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              depth={depth + 1}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
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
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const title = session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12);

  const startRename = useCallback(() => {
    setRenameValue(session.name ?? "");
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [session.name]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (name === (session.name ?? "")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed]);

  const performDelete = useCallback(async () => {
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, onDeleted]);

  // "…" menu: fixed-position portal so the sidebar's overflow/backdrop-filter can't clip it
  const MENU_WIDTH = 190;
  const toggleMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (menuOpen) { setMenuOpen(false); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const estHeight = 124;
    const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    let top = rect.bottom + 4;
    if (top + estHeight > window.innerHeight - 8) top = rect.top - estHeight - 4;
    setMenuPos({ top, left });
    setMenuOpen(true);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (menuButtonRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (ev: KeyboardEvent) => { if (ev.key === "Escape") setMenuOpen(false); };
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

  // Fixed-height outer wrapper — content swaps in place so the list never reflows.
  // Matches the Chats/Files view-switcher tab height.
  const ITEM_HEIGHT = 28;

  return (
    <div
      className={`session-item${isSelected ? " is-selected" : ""}${isRunning ? " is-running" : ""}${isUnread ? " is-unread" : ""}`}
      onClick={confirmDelete || renaming ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: 14,
        paddingRight: 8,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "color-mix(in srgb, var(--danger) 6%, transparent)"
          : isSelected ? "var(--bg-selected)" : (hovered || menuOpen) ? "var(--bg-hover)" : "transparent",
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
                background: "var(--bg)", border: "1px solid var(--border)",
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
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "3px 8px",
            border: "1px solid var(--accent)",
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
              chat-bubble glyph for every session. */}
          {isRunning ? (
            <RunningSessionIndicator />
          ) : isUnread ? (
            <UnreadSessionIndicator />
          ) : (
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
          )}
          <span
            className="session-item-title"
            title={title}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 13,
              fontWeight: isSelected ? 500 : 400,
              lineHeight: 1.4,
              color: "var(--text)",
            }}
          >
            {title}
          </span>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={collapsed ? "Expand forks" : "Collapse forks"}
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

          {/* "…" menu entry — shown on hover / selection / while menu is open */}
          {(hovered || isSelected || menuOpen) && (
            <button
              ref={menuButtonRef}
              onClick={toggleMenu}
              title={t("sidebar.moreActions")}
              aria-label={t("sidebar.moreActions")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24, padding: 0, flexShrink: 0,
                background: menuOpen ? "var(--bg-selected)" : "none",
                border: "none", borderRadius: 6,
                color: "var(--text-muted)", cursor: "pointer",
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-selected)"; e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = menuOpen ? "var(--bg-selected)" : "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.7" />
                <circle cx="12" cy="12" r="1.7" />
                <circle cx="19" cy="12" r="1.7" />
              </svg>
            </button>
          )}

          {menuOpen && menuPos && createPortal(
            <div
              ref={menuRef}
              className="native-popover session-item-menu"
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
                  fontSize: 12.5, textAlign: "left",
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
                  fontSize: 12.5, textAlign: "left",
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
                  {formatRelativeTime(session.created)} · {t("sidebar.messagesCount", { count: session.messageCount })}
                </div>
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
