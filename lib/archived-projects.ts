"use client";

// Fork-owned: the sidebar's project archive. Archived project roots leave the
// project list for the Archive group at its bottom; their sessions stay
// readable there, but a new session needs the project restored first (or the
// folder picked again through "Add project", which restores it). The sidebar
// and AppShell both read this store: AppShell's own new-session entry points
// (keyboard shortcut, native app menu, composer folder pick) must honour it too.

import { useSyncExternalStore } from "react";
import { APP_PREF_KEYS, getPref, getPrefJson, removePref, setPref, setPrefJson } from "./app-prefs";

const EMPTY: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
let cached: ReadonlySet<string> | null = null;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function emit(): void {
  listeners.forEach((cb) => cb());
}

/** Archived project roots; one stable Set per change so it can be a snapshot. */
export function readArchivedProjects(): ReadonlySet<string> {
  if (cached) return cached;
  const stored = getPrefJson<unknown>(APP_PREF_KEYS.archivedProjects);
  cached = Array.isArray(stored)
    ? new Set(stored.filter((root): root is string => typeof root === "string"))
    : EMPTY;
  return cached;
}

function write(next: ReadonlySet<string>): void {
  cached = next;
  if (next.size === 0) removePref(APP_PREF_KEYS.archivedProjects);
  else setPrefJson(APP_PREF_KEYS.archivedProjects, [...next]);
  emit();
}

export function archiveProjectRoot(projectRoot: string): void {
  const current = readArchivedProjects();
  if (current.has(projectRoot)) return;
  write(new Set([...current, projectRoot]));
}

/** Returns true when the root was archived (and is now restored). */
export function restoreProjectRoot(projectRoot: string): boolean {
  const current = readArchivedProjects();
  if (!current.has(projectRoot)) return false;
  const next = new Set(current);
  next.delete(projectRoot);
  write(next);
  return true;
}

/**
 * The archived project `cwd` belongs to, or null. A worktree checkout is not
 * under its project root on disk, so the session list supplies the mapping.
 */
export function archivedProjectRootFor(
  cwd: string,
  sessions: readonly { cwd: string; projectRoot?: string | null }[],
  archived: ReadonlySet<string> = readArchivedProjects(),
): string | null {
  if (archived.has(cwd)) return cwd;
  for (const session of sessions) {
    if (session.cwd !== cwd) continue;
    const root = session.projectRoot ?? session.cwd;
    if (archived.has(root)) return root;
  }
  return null;
}

/** Server render and hydration see an empty archive; the client store takes over after. */
export function useArchivedProjects(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, readArchivedProjects, () => EMPTY);
}

// The Archive group's own fold. Folded by default: "1" only while expanded.
const readArchiveExpanded = () => getPref(APP_PREF_KEYS.archiveExpanded) === "1";

export function useArchiveExpanded(): boolean {
  return useSyncExternalStore(subscribe, readArchiveExpanded, () => false);
}

export function setArchiveExpanded(expanded: boolean): void {
  if (expanded) setPref(APP_PREF_KEYS.archiveExpanded, "1");
  else removePref(APP_PREF_KEYS.archiveExpanded);
  emit();
}
