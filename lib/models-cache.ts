import type { ModelScopeWarning } from "./model-scope-warnings";

export interface ModelsData {
  models: Record<string, string>;
  modelList: { id: string; name: string; provider: string; providerName: string; input?: string[] }[];
  defaultModel: { provider: string; modelId: string } | null;
  /** Resolved thinking level a new session starts with when the user has not picked one. */
  defaultThinkingLevel: string | null;
  /** `defaultThinkingLevel` as saved in settings, which the reasoning selector's star marks. */
  savedDefaultThinkingLevel: string | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
  /** `provider/modelId` → thinking level pinned by an `enabledModels` `:level` suffix. */
  thinkingLevelPins: Record<string, string>;
  modelError?: string;
  /** Warnings from resolving the `enabledModels` scope (e.g. a pattern matched nothing). */
  modelScopeWarnings?: ModelScopeWarning[];
}

interface ModelsCacheState {
  entries: Map<string, { data: ModelsData; expiresAt: number }>;
  inFlight: Map<string, Promise<ModelsData>>;
  generation: number;
}

declare global {
  var __piModelsCacheState: ModelsCacheState | undefined;
}

const MODELS_CACHE_TTL_MS = 60_000;
const MAX_MODELS_CACHE_ENTRIES = 32;
/** Lets the requests of a session switch finish before a background refresh blocks the loop. */
const STALE_REFRESH_DELAY_MS = 1_500;
// Never interpolate the caught error here; SDK errors can contain paths and provider details.
const SAFE_MODEL_LOAD_FAILURE_MESSAGE = "Model list is temporarily unavailable. Check your configuration and try again.";

function getModelsCacheState(): ModelsCacheState {
  if (!globalThis.__piModelsCacheState) {
    globalThis.__piModelsCacheState = {
      entries: new Map(),
      inFlight: new Map(),
      generation: 0,
    };
  }
  return globalThis.__piModelsCacheState;
}

export function invalidateModelsCache(): void {
  const state = getModelsCacheState();
  state.generation += 1;
  state.entries.clear();
  state.inFlight.clear();
}

export function withModelRuntimeError(data: ModelsData, modelError: string | undefined): ModelsData {
  return modelError ? { ...data, modelError } : data;
}

export function withSafeModelLoadFailure(data: ModelsData): ModelsData {
  return { ...data, modelError: SAFE_MODEL_LOAD_FAILURE_MESSAGE };
}

/**
 * Model lists keyed by cwd. A fresh entry is returned as is. An expired one is still
 * returned at once, and a refresh starts a moment later in the background: building the
 * SDK services blocks the event loop (extension imports, skill scans), and running that
 * inside a session switch held up the session's own read by up to a second. Explicit
 * config changes call `invalidateModelsCache()`, so the TTL only catches edits made
 * outside the app, which the next request after the refresh then sees.
 */
export function loadModelsWithCache(cwd: string, loader: () => Promise<ModelsData>): Promise<ModelsData> {
  const state = getModelsCacheState();
  const cached = state.entries.get(cwd);
  if (cached) {
    if (cached.expiresAt <= Date.now() && !state.inFlight.has(cwd)) {
      const generation = state.generation;
      const timer = setTimeout(() => {
        if (state.generation !== generation || state.inFlight.has(cwd)) return;
        // A failed refresh keeps serving the old list; the next request tries again.
        startLoad(state, cwd, loader).catch(() => { cached.expiresAt = 0; });
      }, STALE_REFRESH_DELAY_MS);
      timer.unref?.();
      // Mark the refresh as scheduled so concurrent stale hits start only one.
      cached.expiresAt = Number.POSITIVE_INFINITY;
    }
    return Promise.resolve(cached.data);
  }

  return state.inFlight.get(cwd) ?? startLoad(state, cwd, loader);
}

function startLoad(state: ModelsCacheState, cwd: string, loader: () => Promise<ModelsData>): Promise<ModelsData> {
  const generation = state.generation;
  const loadPromise: Promise<ModelsData> = Promise.resolve()
    .then(loader)
    .then((data) => {
      if (state.generation === generation && state.inFlight.get(cwd) === loadPromise) {
        state.entries.delete(cwd);
        while (state.entries.size >= MAX_MODELS_CACHE_ENTRIES) {
          const oldestKey = state.entries.keys().next().value;
          if (oldestKey === undefined) break;
          state.entries.delete(oldestKey);
        }
        state.entries.set(cwd, { data, expiresAt: Date.now() + MODELS_CACHE_TTL_MS });
      }
      return data;
    })
    .finally(() => {
      if (state.inFlight.get(cwd) === loadPromise) state.inFlight.delete(cwd);
    });

  state.inFlight.set(cwd, loadPromise);
  return loadPromise;
}
