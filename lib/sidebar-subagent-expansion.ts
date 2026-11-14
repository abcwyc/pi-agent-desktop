/**
 * Which sidebar rows show their subagent / side chat children (#237).
 *
 * Children are folded by default; the ids of the rows the user unfolded are
 * kept in localStorage so the choice survives reloads and project switches.
 * The list is capped, newest choice last, so it cannot grow without bound.
 * Reads go through `useSyncExternalStore` with an empty server snapshot, so the
 * first client render matches the server HTML (all folded).
 */

import { APP_PREF_KEYS, getPrefJson, removePref, setPrefJson } from "./app-prefs";

export const MAX_EXPANDED_SUBAGENT_ROWS = 300;

const EMPTY: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> | null = null;

/** Stored value → ids, dropping anything that is not a non-empty string. */
export function parseExpandedSubagentRows(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].slice(-MAX_EXPANDED_SUBAGENT_ROWS);
}

/** The new id list after unfolding (`expanded`) or folding one row. */
export function nextExpandedSubagentRows(current: Iterable<string>, id: string, expanded: boolean): string[] {
  const ids = [...current].filter((item) => item !== id);
  if (expanded) ids.push(id);
  return ids.slice(-MAX_EXPANDED_SUBAGENT_ROWS);
}

export function subscribeExpandedSubagentRows(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function readExpandedSubagentRows(): ReadonlySet<string> {
  if (!snapshot) snapshot = new Set(parseExpandedSubagentRows(getPrefJson<unknown>(APP_PREF_KEYS.expandedSubagentRows)));
  return snapshot;
}

export function serverExpandedSubagentRows(): ReadonlySet<string> {
  return EMPTY;
}

export function setSubagentRowExpanded(id: string, expanded: boolean): void {
  const current = readExpandedSubagentRows();
  if (current.has(id) === expanded) return;
  const ids = nextExpandedSubagentRows(current, id, expanded);
  snapshot = new Set(ids);
  if (ids.length === 0) removePref(APP_PREF_KEYS.expandedSubagentRows);
  else setPrefJson(APP_PREF_KEYS.expandedSubagentRows, ids);
  for (const listener of listeners) listener();
}
