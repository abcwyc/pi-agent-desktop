/**
 * Side-chat tabs in the right panel (C1, upstream ADR 0007), kept in this
 * browser tab's sessionStorage: each tab remembers the main session it was
 * opened beside, so switching sessions shows only that session's side chats
 * and returning (or reloading) brings them back.
 */
export const SIDE_TABS_KEY = "pi-web:side-tabs";

export interface SideTab {
  sessionId: string;
  /** The main session the side chat was forked from. */
  parentId: string;
}

export function readSideTabs(raw: string | null): SideTab[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const { sessionId, parentId } = item as Record<string, unknown>;
      if (typeof sessionId !== "string" || typeof parentId !== "string" || !sessionId || !parentId) return [];
      if (seen.has(sessionId)) return [];
      seen.add(sessionId);
      return [{ sessionId, parentId }];
    });
  } catch {
    return [];
  }
}

/** The stored value, or null to remove the key when no tab is left. */
export function writeSideTabs(tabs: readonly SideTab[]): string | null {
  return tabs.length ? JSON.stringify(tabs) : null;
}

/** Adds a tab (once), keeping the others in their order. */
export function addSideTab(tabs: readonly SideTab[], tab: SideTab): SideTab[] {
  return tabs.some((item) => item.sessionId === tab.sessionId) ? [...tabs] : [...tabs, tab];
}

/**
 * Drops tabs whose side chat is gone: its parent is in the catalog but it is
 * not. A tab whose side chat the catalog has not listed yet (just forked)
 * stays until the catalog has shown it once (`seen`).
 */
export function pruneSideTabs(
  tabs: readonly SideTab[],
  catalogIds: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): SideTab[] {
  const next = tabs.filter((tab) => catalogIds.has(tab.sessionId) || !catalogIds.has(tab.parentId) || !seen.has(tab.sessionId));
  return next.length === tabs.length ? (tabs as SideTab[]) : next;
}
