/**
 * "Enjoying Pi Agent? Star us on GitHub" prompt.
 *
 * Shown at most once per install: after the app has been in use for
 * STAR_PROMPT_MIN_AGE_MS and a run that did real work (see isComplexRun)
 * has just finished. Dismissing or starring both retire it for good.
 */
import { APP_PREF_KEYS, getPrefJson, setPrefJson } from "./app-prefs";

export const STAR_PROMPT_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A run with this many tool calls counts as a complex task on its own. */
export const COMPLEX_RUN_MIN_TOOL_CALLS = 8;
/** A long run counts too, as long as it used tools at all (not just a long reply). */
export const COMPLEX_RUN_MIN_DURATION_MS = 3 * 60 * 1000;
export const COMPLEX_RUN_MIN_TOOL_CALLS_WHEN_LONG = 3;

export interface RunSummary {
  aborted: boolean;
  /** Top-level tool calls the run made. */
  toolCalls?: number;
  /** Wall time from the prompt to the run settling. */
  durationMs?: number;
}

export interface StarPromptState {
  /** First time this install's UI was opened (ms). */
  firstSeenAt: number;
  /** Set once the prompt was shown and answered either way. */
  resolvedAt?: number;
  outcome?: "starred" | "dismissed";
}

export function isComplexRun(run: RunSummary): boolean {
  if (run.aborted) return false;
  const toolCalls = run.toolCalls ?? 0;
  const durationMs = run.durationMs ?? 0;
  if (toolCalls >= COMPLEX_RUN_MIN_TOOL_CALLS) return true;
  return durationMs >= COMPLEX_RUN_MIN_DURATION_MS && toolCalls >= COMPLEX_RUN_MIN_TOOL_CALLS_WHEN_LONG;
}

export function shouldShowStarPrompt(state: StarPromptState, run: RunSummary, now: number): boolean {
  if (state.resolvedAt !== undefined) return false;
  if (now - state.firstSeenAt < STAR_PROMPT_MIN_AGE_MS) return false;
  return isComplexRun(run);
}

function parseState(value: unknown): StarPromptState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<StarPromptState>;
  if (typeof record.firstSeenAt !== "number" || !Number.isFinite(record.firstSeenAt)) return null;
  return {
    firstSeenAt: record.firstSeenAt,
    ...(typeof record.resolvedAt === "number" ? { resolvedAt: record.resolvedAt } : {}),
    ...(record.outcome === "starred" || record.outcome === "dismissed" ? { outcome: record.outcome } : {}),
  };
}

/** Reads the stored state, recording `now` as the first-seen time on first call. */
export function loadStarPromptState(now = Date.now()): StarPromptState {
  const stored = parseState(getPrefJson<unknown>(APP_PREF_KEYS.starPrompt));
  if (stored) return stored;
  const fresh: StarPromptState = { firstSeenAt: now };
  setPrefJson(APP_PREF_KEYS.starPrompt, fresh);
  return fresh;
}

export function resolveStarPrompt(outcome: "starred" | "dismissed", now = Date.now()): void {
  const state = loadStarPromptState(now);
  setPrefJson(APP_PREF_KEYS.starPrompt, { ...state, resolvedAt: now, outcome });
}
