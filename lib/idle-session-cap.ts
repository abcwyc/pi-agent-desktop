/**
 * Cap on warm sessions nobody is using. Opening a session to read it starts a
 * wrapper that stays loaded for the idle timeout (10 minutes): on a real ~/.pi,
 * opening one 135 MB transcript held ~160 MB of heap for that long, and every
 * further large session browsed in that window added its own.
 *
 * Only wrappers that are not running, have no SSE listener and have been
 * unwatched for IDLE_SESSION_CAP_GRACE_MS count; the most recently left one is
 * always kept, so going back to the session just left is still instant.
 */
export const IDLE_SESSION_CAP_MAX_COUNT = 4;
/** Session-file bytes, a proxy for the heap a loaded transcript holds. */
export const IDLE_SESSION_CAP_MAX_BYTES = 256 * 1024 * 1024;
/** An EventSource reconnect or a session switch briefly leaves zero listeners. */
export const IDLE_SESSION_CAP_GRACE_MS = 30_000;

export interface IdleSessionCandidate {
  id: string;
  /** When the session last had a listener or a command (ms epoch). */
  idleSince: number;
  bytes: number;
}

export interface IdleSessionCapLimits {
  maxCount?: number;
  maxBytes?: number;
}

/**
 * Ids to shut down, oldest first. Walking from the most recently left session,
 * each one is kept if it still fits the count and the byte budget; the newest
 * is kept even when it alone is over budget.
 */
export function selectIdleSessionsToEvict(
  candidates: readonly IdleSessionCandidate[],
  { maxCount = IDLE_SESSION_CAP_MAX_COUNT, maxBytes = IDLE_SESSION_CAP_MAX_BYTES }: IdleSessionCapLimits = {},
): string[] {
  const newestFirst = [...candidates].sort((a, b) => b.idleSince - a.idleSince);
  const evict: string[] = [];
  let keptCount = 0;
  let keptBytes = 0;
  for (const candidate of newestFirst) {
    const fits = keptCount === 0
      || (keptCount < maxCount && keptBytes + candidate.bytes <= maxBytes);
    if (fits) {
      keptCount += 1;
      keptBytes += candidate.bytes;
    } else {
      evict.push(candidate.id);
    }
  }
  return evict.reverse();
}
