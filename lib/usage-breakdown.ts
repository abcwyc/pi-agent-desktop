import type { AgentMessage, AgentUsage, SessionEntry } from "./types";

/** Cost and tokens one model (or the unattributed bucket) accounts for in a session. */
export interface UsageCostBreakdownEntry {
  key: string;
  cost: number;
  tokens: number;
}

/** pi's bucket for usage no model answered for: tool results, compaction and branch summaries. */
export const UNATTRIBUTED_USAGE_KEY = "Tools/summaries";

interface Totals {
  cost: number;
  tokens: number;
}

function addUsage(totalsByKey: Map<string, Totals>, key: string, usage: AgentUsage | undefined): void {
  if (!usage) return;
  const totals = totalsByKey.get(key) ?? { cost: 0, tokens: 0 };
  totals.cost += usage.cost?.total ?? 0;
  totals.tokens += (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  totalsByKey.set(key, totals);
}

function addMessage(totalsByKey: Map<string, Totals>, message: AgentMessage): void {
  if (message.role === "assistant") {
    addUsage(totalsByKey, `${message.provider}/${message.responseModel ?? message.model}`, message.usage);
  } else if (message.role === "toolResult") {
    addUsage(totalsByKey, UNATTRIBUTED_USAGE_KEY, message.usage);
  }
}

function finish(totalsByKey: Map<string, Totals>): UsageCostBreakdownEntry[] {
  return Array.from(totalsByKey, ([key, totals]) => ({ key, cost: totals.cost, tokens: totals.tokens }))
    .filter((entry) => entry.cost > 0 || entry.tokens > 0)
    .sort((a, b) => b.cost - a.cost);
}

/**
 * Port of pi's `getUsageCostBreakdown()` (core/usage-totals.ts, not exported): what `/session`
 * lists under Cost. Assistant usage is keyed by the model that actually answered, so a virtual
 * model's requests show up under the physical models it routed to; cache-warming `usage`
 * entries count for their model; everything else lands in one bucket.
 */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
  const totalsByKey = new Map<string, Totals>();
  for (const entry of entries) {
    if (entry.type === "message") addMessage(totalsByKey, entry.message as AgentMessage);
    else if (entry.type === "usage") addUsage(totalsByKey, `${entry.provider}/${entry.model}`, entry.usage);
    else if (entry.type === "compaction" || entry.type === "branch_summary") {
      addUsage(totalsByKey, UNATTRIBUTED_USAGE_KEY, entry.usage);
    }
  }
  return finish(totalsByKey);
}

function breakdownOfMessages(messages: AgentMessage[]): Map<string, Totals> {
  const totalsByKey = new Map<string, Totals>();
  for (const message of messages) addMessage(totalsByKey, message);
  return totalsByKey;
}

/**
 * The file's breakdown plus what streamed in since it was read, the same way
 * `mergeSessionStats()` advances the totals.
 */
export function mergeUsageBreakdown(
  fileBreakdown: UsageCostBreakdownEntry[] | undefined,
  loadedMessages: AgentMessage[],
  currentMessages: AgentMessage[],
): UsageCostBreakdownEntry[] {
  const totalsByKey = new Map<string, Totals>(
    (fileBreakdown ?? []).map((entry) => [entry.key, { cost: entry.cost, tokens: entry.tokens }]),
  );
  const loaded = breakdownOfMessages(loadedMessages);
  for (const [key, current] of breakdownOfMessages(currentMessages)) {
    const before = loaded.get(key) ?? { cost: 0, tokens: 0 };
    const totals = totalsByKey.get(key) ?? { cost: 0, tokens: 0 };
    totals.cost += Math.max(0, current.cost - before.cost);
    totals.tokens += Math.max(0, current.tokens - before.tokens);
    totalsByKey.set(key, totals);
  }
  return finish(totalsByKey);
}

/** pi's rule: a single row only repeats the total, unless it names a model other than the selected one. */
export function shouldShowUsageBreakdown(
  breakdown: UsageCostBreakdownEntry[] | undefined,
  selectedModelKey: string | undefined,
): boolean {
  if (!breakdown || breakdown.length === 0) return false;
  return breakdown.length > 1 || breakdown[0].key !== selectedModelKey;
}
