const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type EffortLevel = typeof EFFORT_LEVELS[number];

export interface DiscoveredModel {
  id: string;
  name?: string;
  // Capabilities the upstream list publishes, as models.json fields (#856).
  reasoning?: true;
  thinkingLevelMap?: Partial<Record<EffortLevel, string | null>>;
  contextWindow?: number;
  maxTokens?: number;
}

// Only fields whose meaning does not vary between gateways. `max_tokens` is
// left out: LiteLLM, for one, fills it with either the input or output limit.
const CONTEXT_WINDOW_FIELDS = [
  "context_length", "contextLength", "context_window", "contextWindow",
  "max_model_len", "max_input_tokens", "inputTokenLimit",
];
const MAX_TOKENS_FIELDS = ["max_output_tokens", "maxOutputTokens", "max_completion_tokens", "outputTokenLimit"];
const REASONING_FIELDS = ["supports_reasoning", "supportsReasoning", "reasoning", "thinking"];
const EFFORT_LIST_FIELDS = ["supported_efforts", "supportedEfforts"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstPositiveInteger(value: Record<string, unknown>, fields: readonly string[]): number | undefined {
  for (const field of fields) {
    const raw = value[field];
    const number = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
    if (typeof number === "number" && Number.isSafeInteger(number) && number > 0) return number;
  }
  return undefined;
}

/**
 * An advertised effort list names pi's own levels, which pi sends as the
 * effort when thinkingLevelMap has no entry. Every level it leaves out is
 * marked unsupported (null), and `xhigh` / `max` need an entry to be offered at
 * all. `off` stays unmapped: the list does not say whether thinking can be
 * turned off. A list naming none of pi's levels maps nothing.
 */
function thinkingLevelMapFromEfforts(value: Record<string, unknown>): DiscoveredModel["thinkingLevelMap"] {
  const list = EFFORT_LIST_FIELDS.map((field) => value[field]).find(Array.isArray);
  if (!list) return undefined;
  const advertised = new Set(list.filter((effort): effort is string => typeof effort === "string"));
  if (!EFFORT_LEVELS.some((level) => advertised.has(level))) return undefined;
  const map: NonNullable<DiscoveredModel["thinkingLevelMap"]> = {};
  for (const level of EFFORT_LEVELS) {
    if (!advertised.has(level)) map[level] = null;
    else if (level === "xhigh" || level === "max") map[level] = level;
  }
  return map;
}

function capabilitiesFromValue(value: Record<string, unknown>): Omit<DiscoveredModel, "id" | "name"> {
  const reasoning = REASONING_FIELDS.some((field) => value[field] === true);
  const thinkingLevelMap = reasoning ? thinkingLevelMapFromEfforts(value) : undefined;
  const contextWindow = firstPositiveInteger(value, CONTEXT_WINDOW_FIELDS);
  const maxTokens = firstPositiveInteger(value, MAX_TOKENS_FIELDS);
  return {
    ...(reasoning ? { reasoning: true } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  };
}

function modelFromValue(value: unknown): DiscoveredModel | null {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id } : null;
  }
  if (!isRecord(value)) return null;

  const rawId = cleanString(value.id) ?? cleanString(value.model) ?? cleanString(value.name);
  if (!rawId) return null;
  const id = rawId.startsWith("models/") ? rawId.slice("models/".length) : rawId;
  if (!id) return null;
  const name = cleanString(value.display_name)
    ?? cleanString(value.displayName)
    ?? (cleanString(value.id) || cleanString(value.model) ? cleanString(value.name) : undefined);
  return { id, ...(name && name !== id ? { name } : {}), ...capabilitiesFromValue(value) };
}

const LIST_KEYS = ["data", "models", "results", "items"] as const;

function listFromResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    // A raw model array passes through; an array of page payloads is flattened.
    return value.flatMap((item) =>
      isRecord(item) && LIST_KEYS.some((key) => Array.isArray(item[key]) || isRecord(item[key]))
        ? listFromResponse(item)
        : [item],
    );
  }
  if (!isRecord(value)) return [];
  for (const key of LIST_KEYS) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    if (isRecord(candidate)) return Object.values(candidate);
  }
  return [];
}

export function parseDiscoveredModels(value: unknown): DiscoveredModel[] {
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const item of listFromResponse(value)) {
    const model = modelFromValue(item);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, {
    numeric: true,
    sensitivity: "base",
  }));
}

// Chat/inference endpoint suffixes people often paste as the Base URL. The model
// list lives on the API root, so strip these before appending "/models".
const ENDPOINT_SUFFIX = /\/(?:chat\/completions|completions|messages|responses|embeddings|rerank|rerankings)$/i;

export function buildModelsListUrl(baseUrl: string, api: string): URL {
  const url = new URL(baseUrl.trim());
  const trimmedPath = url.pathname.replace(/\/+$/, "").replace(ENDPOINT_SUFFIX, "");

  if (!/\/models$/i.test(trimmedPath)) {
    let path = trimmedPath;
    if (api === "anthropic-messages" && !/\/v\d+(?:beta)?$/i.test(path)) path += "/v1";
    if (api === "google-generative-ai" && !/\/v\d+(?:beta)?$/i.test(path)) path += "/v1beta";
    url.pathname = `${path}/models`.replace(/\/+/g, "/");
  }

  // Both APIs accept a page size of 100; Anthropic-compatible proxies often
  // reject anything larger. Larger catalogs are walked via nextPageUrl().
  if (api === "anthropic-messages" && !url.searchParams.has("limit")) {
    url.searchParams.set("limit", "100");
  }
  if (api === "google-generative-ai" && !url.searchParams.has("pageSize")) {
    url.searchParams.set("pageSize", "100");
  }
  return url;
}

/**
 * Given the page just fetched, return the URL of the next page, or null when the
 * listing is exhausted or the API has no cursor pagination (OpenAI-style lists).
 */
export function nextModelsPageUrl(currentUrl: URL, api: string, payload: unknown): URL | null {
  if (!isRecord(payload)) return null;

  if (api === "anthropic-messages") {
    const lastId = cleanString(payload.last_id);
    if (payload.has_more === true && lastId) {
      const next = new URL(currentUrl);
      next.searchParams.set("after_id", lastId);
      return next;
    }
    return null;
  }

  if (api === "google-generative-ai") {
    const token = cleanString(payload.nextPageToken);
    if (token) {
      const next = new URL(currentUrl);
      next.searchParams.set("pageToken", token);
      return next;
    }
    return null;
  }

  return null;
}

export type ModelPageFetchResult =
  | { ok: true; payload: unknown }
  | { ok: false; status: number; error: string };

export type ModelPagesResult =
  | { ok: true; pages: unknown[] }
  | { ok: false; status: number; error: string; upstreamStatus?: number };

/**
 * Walks a provider's paginated model list. A list that is cut short — the page
 * budget runs out while the upstream still offers another page, or a cursor
 * repeats — is an error: returning the pages read so far would look like a
 * complete catalog and silently hide the models on the pages never read.
 */
export async function collectModelPages(input: {
  firstUrl: URL;
  api: string;
  maxPages: number;
  fetchPage: (url: URL) => Promise<ModelPageFetchResult>;
}): Promise<ModelPagesResult> {
  const pages: unknown[] = [];
  const seen = new Set<string>();
  let pageUrl: URL | null = input.firstUrl;

  while (pageUrl) {
    if (pages.length >= input.maxPages) {
      return {
        ok: false,
        status: 502,
        error: `The upstream model list has more than ${input.maxPages} pages; stopped instead of showing a partial list.`,
      };
    }
    const key = pageUrl.toString();
    if (seen.has(key)) {
      return {
        ok: false,
        status: 502,
        error: "The upstream model list repeated a page cursor; stopped instead of showing a partial list.",
      };
    }
    seen.add(key);

    const result = await input.fetchPage(pageUrl);
    if (!result.ok) {
      return { ok: false, status: 502, error: result.error, upstreamStatus: result.status };
    }
    pages.push(result.payload);
    pageUrl = nextModelsPageUrl(pageUrl, input.api, result.payload);
  }

  return { ok: true, pages };
}
