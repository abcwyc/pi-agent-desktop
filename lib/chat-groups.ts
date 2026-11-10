import type { SessionFamily } from "./session-family";

/**
 * How the sidebar's Chats section orders its chats: pinned ones first, then by how recently
 * they were active. Rows already show their own relative time, so there are no date groups.
 */
export function orderChatFamilies(
  families: readonly SessionFamily[],
  pinnedIds: ReadonlySet<string>,
): SessionFamily[] {
  const byRecency = [...families].sort((a, b) => b.latestModified.localeCompare(a.latestModified));
  return [
    ...byRecency.filter((family) => pinnedIds.has(family.root.id)),
    ...byRecency.filter((family) => !pinnedIds.has(family.root.id)),
  ];
}

/** The pinned items first, each part in its given order (a project's pinned sessions, S2). */
export function pinnedFirst<T>(items: readonly T[], isPinned: (item: T) => boolean): T[] {
  return [...items.filter(isPinned), ...items.filter((item) => !isPinned(item))];
}

/** Toggle one id in an id set, returning a new set (React state friendly). */
export function toggleId(ids: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(ids);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
