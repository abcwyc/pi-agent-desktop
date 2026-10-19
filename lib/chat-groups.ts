import type { SessionFamily } from "./session-family";

/**
 * How the sidebar's Chats section lays its chats out: pinned ones first, then by how
 * recently they were active. Pure so the grouping can be pinned in tests.
 */
export type ChatGroupId = "pinned" | "today" | "week" | "earlier";

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Today is the local calendar day, "this week" the six days before it, the rest is earlier. */
export function chatRecencyGroup(modified: string, now: Date = new Date()): Exclude<ChatGroupId, "pinned"> {
  const time = Date.parse(modified);
  if (!Number.isFinite(time)) return "earlier";
  const today = startOfLocalDay(now);
  const day = startOfLocalDay(new Date(time));
  if (day >= today) return "today";
  if (day >= today - 6 * 24 * 60 * 60 * 1000) return "week";
  return "earlier";
}

export interface ChatFamilyGroups {
  /** Families in display order: pinned (most recent first), then the rest by recency. */
  ordered: SessionFamily[];
  /** The group each family (by root id) is shown under. */
  groupOf: Map<string, ChatGroupId>;
}

export function groupChatFamilies(
  families: readonly SessionFamily[],
  pinnedIds: ReadonlySet<string>,
  now: Date = new Date(),
): ChatFamilyGroups {
  const byRecency = [...families].sort((a, b) => b.latestModified.localeCompare(a.latestModified));
  const pinned = byRecency.filter((family) => pinnedIds.has(family.root.id));
  const rest = byRecency.filter((family) => !pinnedIds.has(family.root.id));
  const groupOf = new Map<string, ChatGroupId>();
  for (const family of pinned) groupOf.set(family.root.id, "pinned");
  for (const family of rest) groupOf.set(family.root.id, chatRecencyGroup(family.latestModified, now));
  return { ordered: [...pinned, ...rest], groupOf };
}

/** Toggle one id in an id set, returning a new set (React state friendly). */
export function toggleId(ids: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(ids);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
