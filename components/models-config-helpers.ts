export interface CompatEntry {
  compat?: Record<string, unknown>;
}

export interface HeaderRow {
  id: number;
  name: string;
  value: string;
}

export const MODEL_COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

export type ModelCostKey = (typeof MODEL_COST_KEYS)[number];

export type ModelCostRates = Record<ModelCostKey, number>;

export type ModelCostDraft = Record<ModelCostKey, string>;

export function modelCostToDraft(cost?: Partial<ModelCostRates>): ModelCostDraft {
  return {
    input: cost?.input === undefined ? "" : String(cost.input),
    output: cost?.output === undefined ? "" : String(cost.output),
    cacheRead: cost?.cacheRead === undefined ? "" : String(cost.cacheRead),
    cacheWrite: cost?.cacheWrite === undefined ? "" : String(cost.cacheWrite),
  };
}

export function parseCompleteModelCost(draft: ModelCostDraft): ModelCostRates | undefined {
  if (!hasModelCostDraftValue(draft)) return undefined;

  const parse = (value: string): number | undefined => {
    if (!value.trim()) return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const input = parse(draft.input);
  const output = parse(draft.output);
  const cacheRead = parse(draft.cacheRead);
  const cacheWrite = parse(draft.cacheWrite);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite };
}

export function hasModelCostDraftValue(draft: ModelCostDraft): boolean {
  return MODEL_COST_KEYS.some((key) => draft[key].trim() !== "");
}

export function setCompatBool<T extends CompatEntry>(entry: T, key: string, value: boolean): T {
  return {
    ...entry,
    compat: { ...(entry.compat ?? {}), [key]: value },
  };
}

export function updateHeaderRow(
  rows: readonly HeaderRow[],
  id: number,
  changes: Partial<Pick<HeaderRow, "name" | "value">>,
): HeaderRow[] {
  return rows.map((row) => row.id === id ? { ...row, ...changes } : row);
}

export function serializeHeaderRows(rows: readonly HeaderRow[]): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) headers[name] = row.value;
  }
  return Object.keys(headers).length ? headers : undefined;
}

/** The parts of models.json the rename tracking needs. */
export interface ModelsConfigDraft {
  providers?: Record<string, { models?: { id: string }[] }>;
}

/** Snapshot of the model ids models.json holds, by provider and slot. */
export function savedModelIds(config: ModelsConfigDraft): Map<string, (string | null)[]> {
  return new Map(Object.entries(config.providers ?? {}).map(([name, provider]) => [
    name,
    (provider.models ?? []).map((model) => model.id),
  ]));
}

export function trackAddedModels(slots: Map<string, (string | null)[]>, providerName: string, count: number) {
  if (count <= 0) return;
  const existing = slots.get(providerName) ?? [];
  slots.set(providerName, [...existing, ...Array.from({ length: count }, () => null)]);
}

/** A provider's models in a new order: the draft to set, and the old index now at each slot. */
export interface ModelOrderChange<T extends ModelsConfigDraft> {
  config: T;
  providerName: string;
  order: number[];
}

/** Puts a provider's models in `order` and moves its saved slots along; null when nothing moves. */
function reorderModelEntries<T extends ModelsConfigDraft>(
  config: T,
  slots: Map<string, (string | null)[]>,
  providerName: string,
  order: number[],
): ModelOrderChange<T> | null {
  const providers = config.providers ?? {};
  const provider = providers[providerName];
  const models = provider?.models;
  if (!models || order.every((index, position) => index === position)) return null;
  const saved = slots.get(providerName);
  if (saved) slots.set(providerName, order.map((index) => saved[index] ?? null));
  return {
    config: {
      ...config,
      providers: { ...providers, [providerName]: { ...provider, models: order.map((index) => models[index]) } },
    },
    providerName,
    order,
  };
}

/** Moves one model to slot `to` within its provider; mutates `slots` to match. Null when either slot is outside the list. */
export function moveModelEntry<T extends ModelsConfigDraft>(
  config: T,
  slots: Map<string, (string | null)[]>,
  providerName: string,
  from: number,
  to: number,
): ModelOrderChange<T> | null {
  const models = config.providers?.[providerName]?.models ?? [];
  if (from < 0 || from >= models.length || to < 0 || to >= models.length) return null;
  const order = [...models.keys()];
  order.splice(from, 1);
  order.splice(to, 0, from);
  return reorderModelEntries(config, slots, providerName, order);
}

/** The slot a model dragged from `from` ends up in when dropped before or after the row at `target`. */
export function modelDropIndex(from: number, target: number, after: boolean): number {
  const slot = after ? target + 1 : target;
  return from < slot ? slot - 1 : slot;
}

/** The label a model row shows in the fork's Models sidebar: its id, else its name. */
function modelRowLabel(model: { id: string; name?: string }): string {
  return model.id.trim() || model.name?.trim() || "";
}

/** Sorts a provider's models once by the label its rows show (natural, case-insensitive, stable); mutates `slots` to match. Null when already sorted. */
export function sortModelEntries<T extends ModelsConfigDraft>(
  config: T,
  slots: Map<string, (string | null)[]>,
  providerName: string,
): ModelOrderChange<T> | null {
  const models = config.providers?.[providerName]?.models ?? [];
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const order = [...models.keys()].sort((left, right) =>
    collator.compare(modelRowLabel(models[left]), modelRowLabel(models[right])));
  return reorderModelEntries(config, slots, providerName, order);
}

/**
 * Model ids that changed in place since the last save, as full references.
 *
 * `from` keeps the provider id the settings file still spells, so the server
 * can rewrite the entry before it applies the provider renames.
 */
export function collectModelRenames(
  config: ModelsConfigDraft,
  slots: Map<string, (string | null)[]>,
  providerRenames: Map<string, string>,
): { from: string; to: string }[] {
  const originalProvider = (name: string) => {
    for (const [from, to] of providerRenames) if (to === name) return from;
    return name;
  };

  const renames: { from: string; to: string }[] = [];
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    const saved = slots.get(name);
    if (!saved) continue;
    (provider.models ?? []).forEach((model, index) => {
      const before = saved[index];
      if (!before || !model.id || before === model.id) return;
      renames.push({ from: `${originalProvider(name)}/${before}`, to: `${name}/${model.id}` });
    });
  }
  return renames;
}

/** What the panel remembers between saves to tell renames from edits. */
export interface ProviderRenameTracking {
  /** Provider ids as models.json has them on disk. */
  savedProviders: Set<string>;
  /** Saved provider id -> where renames since the last save moved it. */
  renames: Map<string, string>;
  /** Saved model ids per provider, keyed by the provider's current id. */
  slots: Map<string, (string | null)[]>;
}

/**
 * Moves a provider to a new id, keeping its place in models.json, and records
 * the move so the enabledModels entries can follow it on save.
 *
 * Returns null and records nothing when the provider is gone or the new id is
 * already taken: models.json is keyed by id, so the move would silently
 * replace the other provider.
 */
export function renameProviderEntry<T extends ModelsConfigDraft>(
  config: T,
  tracking: ProviderRenameTracking,
  oldName: string,
  newName: string,
): T | null {
  const providers = config.providers ?? {};
  if (!Object.hasOwn(providers, oldName)) return null;
  if (oldName === newName) return config;
  if (Object.hasOwn(providers, newName)) return null;

  const { renames, savedProviders, slots } = tracking;
  let original = oldName;
  for (const [from, to] of renames) {
    if (to !== oldName) continue;
    original = from;
    break;
  }
  if (original === newName) renames.delete(original);
  else if (savedProviders.has(original)) renames.set(original, newName);
  const saved = slots.get(oldName);
  if (saved) {
    slots.delete(oldName);
    slots.set(newName, saved);
  }

  const entries = Object.entries(providers);
  const index = entries.findIndex(([name]) => name === oldName);
  entries[index] = [newName, entries[index][1]];
  return { ...config, providers: Object.fromEntries(entries) };
}

/** The spec fields a `modelOverrides` entry can set that the model form edits as numbers. */
export const MODEL_SPEC_FIELDS = ["contextWindow", "maxTokens"] as const;

export type ModelSpecField = (typeof MODEL_SPEC_FIELDS)[number];

/**
 * What pi falls back to when a models.json model leaves a spec field out
 * (`modelFromJson` in pi-coding-agent's provider composer). It is the value
 * the session runs with unless a `modelOverrides` entry replaces it.
 */
export const MODEL_SPEC_FALLBACKS: Record<ModelSpecField, number> = {
  contextWindow: 128000,
  maxTokens: 16384,
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One provider's `modelOverrides` entries, in file order, skipping malformed ones. */
export function listModelOverrides(
  modelOverrides: unknown,
): { modelId: string; fields: Record<string, unknown> }[] {
  if (!isPlainRecord(modelOverrides)) return [];
  return Object.entries(modelOverrides).flatMap(([modelId, fields]) =>
    modelId && isPlainRecord(fields) ? [{ modelId, fields }] : []);
}

/**
 * The spec values a provider's `modelOverrides` sets for one model id. pi
 * applies these last, over the built-in model and over a models.json model
 * of the same id, so they are what a session actually gets.
 */
export function modelOverrideSpecs(
  modelOverrides: unknown,
  modelId: string,
): Partial<Record<ModelSpecField, number>> {
  const id = modelId.trim();
  if (!id || !isPlainRecord(modelOverrides)) return {};
  const entry = modelOverrides[id];
  if (!isPlainRecord(entry)) return {};
  const specs: Partial<Record<ModelSpecField, number>> = {};
  for (const field of MODEL_SPEC_FIELDS) {
    const value = entry[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) specs[field] = value;
  }
  return specs;
}

export type ModelSpecHint =
  /** A `modelOverrides` entry sets the field; it wins over the form value. */
  | { kind: "override"; value: number; replacesDraft: boolean }
  /** The field is empty and nothing overrides it: pi uses its fallback. */
  | { kind: "fallback"; value: number }
  /** The form sets the field and nothing overrides it. */
  | { kind: "own" };

/** Which value pi resolves for a spec field, and where it comes from. */
export function resolveModelSpecHint(
  field: ModelSpecField,
  draftValue: number | undefined,
  overrideValue: number | undefined,
): ModelSpecHint {
  if (overrideValue !== undefined) {
    return { kind: "override", value: overrideValue, replacesDraft: draftValue !== undefined };
  }
  if (draftValue === undefined) return { kind: "fallback", value: MODEL_SPEC_FALLBACKS[field] };
  return { kind: "own" };
}
