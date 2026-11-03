/**
 * Cap on warm sessions nobody is using. Opening a session to read it starts a
 * wrapper that stays loaded for the idle timeout (10 minutes): on a real ~/.pi,
 * opening one 135 MB transcript held ~160 MB of heap for that long, and every
 * further large session browsed in that window added its own.
 *
 * Only wrappers that are not running, have no SSE listener and have been
 * unwatched for IDLE_SESSION_CAP_GRACE_MS count; the most recently left one is
 * always kept, so going back to the session just left is still instant.
 *
 * Only bytes are capped, never the number of sessions: small transcripts cost
 * little heap, and 0.8.1's count of 4 evicted ordinary 1-5 MB sessions while
 * the user switched among a handful, so every switch back cold-started a
 * wrapper (re-parsing the transcript and rebinding extensions). The 10-minute
 * idle timeout still releases them all.
 */
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
  maxBytes?: number;
}

/**
 * Ids to shut down, oldest first. Walking from the most recently left session,
 * each one is kept if it still fits the byte budget; the newest is kept even
 * when it alone is over budget.
 */
export function selectIdleSessionsToEvict(
  candidates: readonly IdleSessionCandidate[],
  { maxBytes = IDLE_SESSION_CAP_MAX_BYTES }: IdleSessionCapLimits = {},
): string[] {
  const newestFirst = [...candidates].sort((a, b) => b.idleSince - a.idleSince);
  const evict: string[] = [];
  let keptAny = false;
  let keptBytes = 0;
  for (const candidate of newestFirst) {
    if (!keptAny || keptBytes + candidate.bytes <= maxBytes) {
      keptAny = true;
      keptBytes += candidate.bytes;
    } else {
      evict.push(candidate.id);
    }
  }
  return evict.reverse();
}
