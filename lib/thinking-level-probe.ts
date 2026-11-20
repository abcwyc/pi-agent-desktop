/**
 * Thinking-level probe for a custom model (Settings › Models › Test thinking levels).
 *
 * pi sends a reasoning model's level as the provider's effort value: the model's
 * `thinkingLevelMap` entry when it has one, otherwise the level's own name. A custom
 * model without a map therefore offers every level, and an endpoint that accepts only
 * some of them answers 400 for the rest (Aliyun's GLM-5.3 takes low/high/max only).
 *
 * The probe sends one small request per level and turns the answers into a suggested
 * map: a level the endpoint rejects becomes `null` (pi then leaves it out of the
 * selector), an accepted xhigh/max gets an explicit entry (pi offers those two only
 * with one). Everything it cannot tell apart stays as configured.
 */

/** Levels the probe sends. `off` sends no effort, so the plain connection test covers it. */
export const PROBE_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ProbeLevel = typeof PROBE_LEVELS[number];

export type ThinkingLevelMap = Record<string, string | null>;

/**
 * - accepted: the request carried the value and succeeded.
 * - rejected: the request carried the value and the endpoint refused it (400 / 422)
 *   while the same request without a level succeeded.
 * - not-sent: this model's request format does not put the value on the wire, so
 *   the endpoint's answer says nothing about it.
 * - inconclusive: timeout, rate limit, server error, or no HTTP status.
 * - skipped: the map already disables the level.
 */
export type ProbeOutcome = "accepted" | "rejected" | "not-sent" | "inconclusive" | "skipped";

export interface LevelProbeResult {
  level: ProbeLevel;
  /** The effort value sent for this level, or null when skipped. */
  value: string | null;
  outcome: ProbeOutcome;
  status?: number;
  error?: string;
}

export interface ThinkingProbeSummary {
  results: LevelProbeResult[];
  /** False when no level put its value on the wire: the probe cannot judge this model. */
  applicable: boolean;
  /** Every level that was sent was rejected: likely a compatibility setting, not the levels. */
  allRejected: boolean;
  /** The map to apply; undefined means "no map". */
  suggestedMap: ThinkingLevelMap | undefined;
  /** Whether suggestedMap differs from the map the probe started from. */
  changed: boolean;
}

/** The value pi would send for this level, or null when the map disables it. */
export function probeValueFor(level: ProbeLevel, map: ThinkingLevelMap | undefined): string | null {
  const entry = map?.[level];
  if (entry === null) return null;
  if (typeof entry === "string" && entry.trim()) return entry;
  return level;
}

/**
 * The model the probe request uses: the level gets an explicit entry so pi's clamp
 * keeps it (xhigh/max without an entry would be clamped down to high).
 */
export function probeModelFor<T extends { thinkingLevelMap?: ThinkingLevelMap }>(
  model: T,
  level: ProbeLevel,
  value: string,
): T {
  return { ...model, thinkingLevelMap: { ...(model.thinkingLevelMap ?? {}), [level]: value } };
}

/** Whether the outgoing payload carries `value` as a string anywhere. */
export function payloadCarriesValue(payload: unknown, value: string): boolean {
  const seen = new Set<unknown>();
  const visit = (node: unknown): boolean => {
    if (typeof node === "string") return node === value;
    if (!node || typeof node !== "object" || seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some(visit);
    return Object.values(node as Record<string, unknown>).some(visit);
  };
  return visit(payload);
}

/**
 * The HTTP status of a failed request. The OpenAI SDK throws on a 4xx before the
 * runtime's onResponse runs, so the status often only shows as the error text's
 * leading number ("400 data: {...}", "400 Bad Request").
 */
export function probeFailureStatus(status: number | undefined, errorMessage: string | undefined): number | undefined {
  if (status !== undefined) return status;
  const match = /^\s*(\d{3})\b/.exec(errorMessage ?? "");
  return match ? Number(match[1]) : undefined;
}

/** A failed level request: refused by the endpoint, or a failure that proves nothing. */
export function classifyProbeFailure(status: number | undefined): "rejected" | "inconclusive" {
  return status === 400 || status === 422 ? "rejected" : "inconclusive";
}

/** Turns per-level results into a suggested map. */
export function summarizeThinkingProbe(
  currentMap: ThinkingLevelMap | undefined,
  results: LevelProbeResult[],
): ThinkingProbeSummary {
  const sent = results.filter((r) => r.outcome === "accepted" || r.outcome === "rejected");
  const applicable = sent.length > 0;
  const allRejected = applicable && sent.every((r) => r.outcome === "rejected");

  const next: ThinkingLevelMap = { ...(currentMap ?? {}) };
  // Nulling every level would leave the model without thinking: report it instead.
  if (!allRejected) {
    for (const result of results) {
      if (result.outcome === "rejected") {
        next[result.level] = null;
      } else if (
        result.outcome === "accepted"
        && (result.level === "xhigh" || result.level === "max")
        && !(result.level in next)
        && result.value
      ) {
        next[result.level] = result.value;
      }
    }
  }
  const suggestedMap = Object.keys(next).length ? next : undefined;
  return {
    results,
    applicable,
    allRejected,
    suggestedMap,
    changed: !sameMap(currentMap, suggestedMap),
  };
}

function sameMap(a: ThinkingLevelMap | undefined, b: ThinkingLevelMap | undefined): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!(key in left) || !(key in right) || left[key] !== right[key]) return false;
  }
  return true;
}

/** Runs `task` over `items` with at most `limit` at a time, keeping the input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
