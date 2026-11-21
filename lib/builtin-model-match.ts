/**
 * Matching a custom models.json provider/model against pi's built-in catalog.
 *
 * A custom provider that points at an endpoint pi already ships (Aliyun Token Plan's
 * `token-plan.cn-beijing…` is `qwen-token-plan-cn`) gets none of the per-model
 * settings pi maintains for it: the thinking level map and the request compat. The
 * same model then fails at levels the endpoint refuses (GLM-5.3 takes low/high/max
 * only). Settings › Models uses this to point at the built-in provider and to offer
 * the built-in entry's settings for the same endpoint and model id.
 *
 * Only an exact endpoint match counts: the same model id behind another region or
 * gateway may accept other values.
 */

export type ThinkingLevelMap = Record<string, string | null>;

/** The slice of a pi-ai provider this module reads. */
export interface CatalogProvider {
  id: string;
  name: string;
  baseUrl?: string;
  getModels(): readonly CatalogModel[];
}

export interface CatalogModel {
  id: string;
  name?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: Record<string, unknown>;
}

export interface BuiltinProviderRef {
  id: string;
  name: string;
}

export interface BuiltinModelSettings {
  /** The built-in providers that list this model at this endpoint, first one is the source. */
  providers: BuiltinProviderRef[];
  modelName?: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: Record<string, unknown>;
}

export interface BuiltinMatch {
  /** Built-in providers serving this endpoint. */
  providers: BuiltinProviderRef[];
  /** The built-in settings for this model id at this endpoint, when pi lists it. */
  model: BuiltinModelSettings | null;
}

/**
 * Comparable form of an endpoint: scheme dropped, host lowercased, no query,
 * no trailing slashes. Returns undefined for something that is not a URL.
 */
export function normalizeEndpoint(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.host.toLowerCase()}${path}`;
  } catch {
    return undefined;
  }
}

function modelEndpoint(provider: CatalogProvider, model: CatalogModel): string | undefined {
  return normalizeEndpoint(model.baseUrl ?? provider.baseUrl);
}

function safeModels(provider: CatalogProvider): readonly CatalogModel[] {
  try {
    return provider.getModels();
  } catch {
    return [];
  }
}

export function findBuiltinMatch(
  catalog: readonly CatalogProvider[],
  baseUrl: string | undefined,
  modelId: string | undefined,
): BuiltinMatch {
  const endpoint = normalizeEndpoint(baseUrl);
  if (!endpoint) return { providers: [], model: null };
  const id = modelId?.trim();

  const providers: BuiltinProviderRef[] = [];
  let model: BuiltinModelSettings | null = null;
  for (const provider of catalog) {
    const models = safeModels(provider);
    const servesEndpoint = normalizeEndpoint(provider.baseUrl) === endpoint
      || models.some((entry) => modelEndpoint(provider, entry) === endpoint);
    if (!servesEndpoint) continue;
    const ref = { id: provider.id, name: provider.name };
    providers.push(ref);
    if (!id) continue;
    const entry = models.find((candidate) => candidate.id === id && modelEndpoint(provider, candidate) === endpoint);
    if (!entry) continue;
    if (model) {
      model.providers.push(ref);
      continue;
    }
    model = {
      providers: [ref],
      ...(entry.name ? { modelName: entry.name } : {}),
      reasoning: entry.reasoning === true,
      ...(entry.thinkingLevelMap ? { thinkingLevelMap: { ...entry.thinkingLevelMap } } : {}),
      ...(entry.compat ? { compat: { ...entry.compat } } : {}),
    };
  }
  return { providers, model };
}

/** The draft fields the built-in settings would change, by name. */
export interface BuiltinSettingsDiff {
  reasoning: boolean;
  thinkingLevelMap: boolean;
  /** Compat keys whose effective value differs from the built-in one. */
  compatKeys: string[];
}

export function diffBuiltinSettings(
  builtin: BuiltinModelSettings,
  draft: { reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap },
  effectiveCompat: Record<string, unknown>,
): BuiltinSettingsDiff {
  const compatKeys = Object.entries(builtin.compat ?? {})
    .filter(([key, value]) => !sameJson(effectiveCompat[key], value))
    .map(([key]) => key);
  return {
    reasoning: builtin.reasoning !== (draft.reasoning === true),
    // Only a reasoning model's map matters; a missing built-in map means "no map".
    thinkingLevelMap: builtin.reasoning && !sameJson(draft.thinkingLevelMap ?? {}, builtin.thinkingLevelMap ?? {}),
    compatKeys,
  };
}

export function hasBuiltinDiff(diff: BuiltinSettingsDiff): boolean {
  return diff.reasoning || diff.thinkingLevelMap || diff.compatKeys.length > 0;
}

/** The draft with the built-in reasoning flag, thinking level map and compat applied. */
export function applyBuiltinSettings<T extends {
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: Record<string, unknown>;
}>(draft: T, builtin: BuiltinModelSettings): T {
  const next: T = { ...draft };
  if (builtin.reasoning) next.reasoning = true;
  else delete next.reasoning;
  if (builtin.reasoning && builtin.thinkingLevelMap) next.thinkingLevelMap = { ...builtin.thinkingLevelMap };
  else delete next.thinkingLevelMap;
  // Built-in compat goes on the model entry, over what the provider sets, like the editor's toggles.
  if (builtin.compat && Object.keys(builtin.compat).length) {
    next.compat = { ...(draft.compat ?? {}), ...builtin.compat };
  }
  return next;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}
