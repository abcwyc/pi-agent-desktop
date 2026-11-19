/**
 * Read-only discovery metadata from npm. A pi-package keyword makes a package
 * discoverable, not verified: installation and resource loading remain the SDK's
 * responsibility. This module never downloads a tarball or imports package code.
 */
export interface DiscoveredPlugin {
  name: string;
  description: string;
  version: string;
  publisher: string;
  url: string;
}

export interface PluginSearchResponse {
  packages: DiscoveredPlugin[];
  nextOffset: number | null;
}

const PAGE_SIZE = 20;
const MAX_QUERY_LENGTH = 160;
const cache = new Map<string, { expires: number; value: PluginSearchResponse }>();
const inFlight = new Map<string, Promise<PluginSearchResponse>>();

export function pluginSearchParams(params: URLSearchParams) {
  const query = (params.get("q") ?? "").trim();
  const offset = Number(params.get("offset") ?? 0);
  if (query.length > MAX_QUERY_LENGTH || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) {
    throw new Error("Invalid search parameters");
  }
  return { query, offset };
}

export function parsePluginSearch(data: unknown, offset: number): PluginSearchResponse {
  const body = data as { objects?: { package?: { name?: string; description?: string; version?: string; keywords?: string[]; publisher?: { username?: string } } }[]; total?: number };
  if (!body || !Array.isArray(body.objects) || !Number.isSafeInteger(body.total) || body.total! < 0) throw new Error("Invalid registry response");
  const packages: DiscoveredPlugin[] = [];
  for (const item of body.objects) {
    const p = item?.package;
    if (!p || typeof p.name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(p.name) || !Array.isArray(p.keywords) || !p.keywords.includes("pi-package")) continue;
    packages.push({
      name: p.name,
      description: typeof p.description === "string" ? p.description.slice(0, 1000) : "",
      version: typeof p.version === "string" ? p.version.slice(0, 100) : "",
      publisher: typeof p.publisher?.username === "string" ? p.publisher.username.slice(0, 100) : "",
      url: `https://www.npmjs.com/package/${p.name}`,
    });
  }
  // Advance by raw registry rows, not accepted rows: filtering a malformed or
  // unrelated result must not repeat that row on the next page.
  const next = offset + body.objects.length;
  return { packages, nextOffset: body.objects.length > 0 && next < body.total! && next <= 10000 ? next : null };
}

export async function searchPlugins(query: string, offset: number): Promise<PluginSearchResponse> {
  const key = JSON.stringify([query, offset]);
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  // One caller leaving the page must not cancel another caller's shared lookup.
  // The upstream timeout bounds all waiters; failures are never cached.
  const pending = inFlight.get(key);
  if (pending) return pending;
  const task = fetchPluginSearch(query, offset);
  inFlight.set(key, task);
  try {
    const value = await task;
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + 60_000, value });
    return value;
  } finally { inFlight.delete(key); }
}

async function fetchPluginSearch(query: string, offset: number): Promise<PluginSearchResponse> {
  const url = new URL("https://registry.npmjs.org/-/v1/search");
  // Quote each word so user input cannot introduce registry search operators.
  const words = query.match(/[\p{L}\p{N}_.@/-]+/gu) ?? [];
  url.searchParams.set("text", [...words.map((word) => `"${word}"`), "keywords:pi-package"].join(" "));
  url.searchParams.set("size", String(PAGE_SIZE));
  url.searchParams.set("from", String(offset));
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000), cache: "no-store" });
  if (!response.ok) throw new Error(`Registry search failed (${response.status})`);
  return parsePluginSearch(await response.json(), offset);
}
