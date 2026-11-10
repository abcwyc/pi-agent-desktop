import { existsSync, readFileSync } from "node:fs";
import { getGlobalSettingsPath } from "./global-settings-file";
import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "./artifact-settings";
import { reconfigureHttpDispatcher } from "./http-dispatcher";

/**
 * Settings › General › Network proxy: an HTTP(S) proxy for this app only, so
 * users behind a local proxy (Clash on 127.0.0.1:7890 and the like) need no
 * system-wide TUN mode, and the packaged app works when launched from Finder
 * or the Start menu, where no HTTP_PROXY reaches the process.
 *
 * The proxy is applied by writing the standard variables into `process.env`
 * and rebuilding the global undici dispatcher, so:
 * - every server-side fetch (model APIs, catalogs, OAuth, update checks)
 *   goes through it right away;
 * - processes started afterwards (bash tool, terminals, npx) inherit it;
 * - the desktop updater reads the effective URL from GET /api/network-proxy.
 *
 * Precedence: this setting when switched on > the environment the server
 * started with > `httpProxy` in pi's own settings.json (what the pi CLI uses).
 */

export interface NetworkProxySettings {
  enabled: boolean;
  url: string;
  noProxy: string;
}

export type NetworkProxySource = "settings" | "environment" | "pi-settings" | "none";

export interface EffectiveNetworkProxy {
  source: NetworkProxySource;
  /** The proxy in use for https requests, or null when they go direct. */
  url: string | null;
  noProxy: string;
}

export const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";
const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1"];

export const DEFAULT_NETWORK_PROXY_SETTINGS: NetworkProxySettings = {
  enabled: false,
  url: "",
  noProxy: DEFAULT_NO_PROXY,
};

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

type ProxyEnvKey = typeof PROXY_ENV_KEYS[number];
type ProxyEnvSnapshot = Partial<Record<ProxyEnvKey, string>>;

type NetworkProxyGlobal = typeof globalThis & {
  __piWebProxyEnvBaseline?: ProxyEnvSnapshot;
};

const proxyGlobal = globalThis as NetworkProxyGlobal;

export type ProxyUrlResult = { ok: true; url: string } | { ok: false; error: string };

/** Accept http:// and https:// proxies with a host; an address without a scheme gets http://. */
export function normalizeProxyUrl(raw: string): ProxyUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Enter a proxy address, such as http://127.0.0.1:7890." };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: "The proxy address is not a valid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Unsupported proxy protocol ${parsed.protocol.replace(/:$/, "")}://. Use http:// or https://.` };
  }
  if (!parsed.hostname) return { ok: false, error: "The proxy address has no host." };
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    return { ok: false, error: "The proxy address must not contain a path." };
  }
  return { ok: true, url: `${parsed.protocol}//${parsed.username ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@` : ""}${parsed.host}` };
}

/** Comma-separated, de-duplicated, always keeping this computer's loopback names off the proxy. */
export function normalizeNoProxy(raw: string): string {
  const entries = raw.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of [...LOOPBACK_NO_PROXY, ...entries]) {
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result.join(",");
}

/** The password of a proxy URL replaced by `***`, for any response that is not to this computer. */
export function redactProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.password) return url;
    parsed.password = "***";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function asSettings(value: unknown): NetworkProxySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_NETWORK_PROXY_SETTINGS };
  const record = value as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    url: typeof record.url === "string" ? record.url : "",
    noProxy: typeof record.noProxy === "string" ? record.noProxy : DEFAULT_NO_PROXY,
  };
}

export function readNetworkProxySettings(settingsPath = getPiWebSettingsPath()): NetworkProxySettings {
  try {
    return asSettings(readStored(settingsPath).networkProxy);
  } catch {
    return { ...DEFAULT_NETWORK_PROXY_SETTINGS };
  }
}

export type NetworkProxyUpdateResult =
  | { ok: true; settings: NetworkProxySettings }
  | { ok: false; error: string };

/** Validate a PUT body. The address is checked even when switched off, so a saved draft is always usable. */
export function parseNetworkProxyUpdate(body: unknown): NetworkProxyUpdateResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Expected an object" };
  const record = body as Record<string, unknown>;
  if (typeof record.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
  if (typeof record.url !== "string") return { ok: false, error: "url must be a string" };
  if (record.noProxy !== undefined && typeof record.noProxy !== "string") {
    return { ok: false, error: "noProxy must be a string" };
  }
  let url = record.url.trim();
  if (url || record.enabled) {
    const normalized = normalizeProxyUrl(url);
    if (!normalized.ok) return normalized;
    url = normalized.url;
  }
  return {
    ok: true,
    settings: {
      enabled: record.enabled,
      url,
      noProxy: normalizeNoProxy(typeof record.noProxy === "string" ? record.noProxy : DEFAULT_NO_PROXY),
    },
  };
}

export function writeNetworkProxySettings(
  settings: NetworkProxySettings,
  settingsPath = getPiWebSettingsPath(),
): NetworkProxySettings {
  updatePiWebSettings({ networkProxy: settings }, settingsPath);
  return readNetworkProxySettings(settingsPath);
}

/** `httpProxy` from pi's global settings.json, the proxy the pi CLI applies. */
export function readPiSettingsHttpProxy(globalSettingsPath = getGlobalSettingsPath()): string | null {
  try {
    if (!existsSync(globalSettingsPath)) return null;
    const parsed: unknown = JSON.parse(readFileSync(globalSettingsPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>).httpProxy;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/** The proxy variables the server process started with, captured once so switching off restores them. */
function envBaseline(): ProxyEnvSnapshot {
  if (!proxyGlobal.__piWebProxyEnvBaseline) {
    const snapshot: ProxyEnvSnapshot = {};
    for (const key of PROXY_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) snapshot[key] = value;
    }
    proxyGlobal.__piWebProxyEnvBaseline = snapshot;
  }
  return proxyGlobal.__piWebProxyEnvBaseline;
}

function writeProxyEnv(values: ProxyEnvSnapshot): void {
  for (const key of PROXY_ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** The values undici and most CLIs read: lowercase first, as undici does. */
function currentEffective(source: NetworkProxySource): EffectiveNetworkProxy {
  const url = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy ?? process.env.HTTP_PROXY ?? null;
  const noProxy = process.env.no_proxy ?? process.env.NO_PROXY ?? "";
  return { source: url ? source : "none", url: url || null, noProxy };
}

export interface ApplyNetworkProxyOptions {
  piSettingsHttpProxy?: string | null;
  /** Rebuild the global dispatcher; tests that only check the environment pass false. */
  reconfigure?: boolean;
}

/** Put the proxy into effect for this process and everything it starts from now on. */
export function applyNetworkProxySettings(
  settings: NetworkProxySettings,
  options: ApplyNetworkProxyOptions = {},
): EffectiveNetworkProxy {
  const baseline = envBaseline();
  const normalized = settings.enabled ? normalizeProxyUrl(settings.url) : null;
  let source: NetworkProxySource;

  if (normalized?.ok) {
    const noProxy = normalizeNoProxy(settings.noProxy);
    writeProxyEnv({
      HTTP_PROXY: normalized.url,
      HTTPS_PROXY: normalized.url,
      http_proxy: normalized.url,
      https_proxy: normalized.url,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    });
    source = "settings";
  } else {
    writeProxyEnv(baseline);
    const hasEnvProxy = Boolean(baseline.HTTP_PROXY || baseline.HTTPS_PROXY || baseline.http_proxy || baseline.https_proxy);
    const piProxy = options.piSettingsHttpProxy === undefined ? readPiSettingsHttpProxy() : options.piSettingsHttpProxy;
    if (!hasEnvProxy && piProxy) {
      // Same as the pi CLI: HTTP_PROXY ??= httpProxy, HTTPS_PROXY ??= httpProxy.
      process.env.HTTP_PROXY = piProxy;
      process.env.HTTPS_PROXY = piProxy;
      source = "pi-settings";
    } else {
      source = "environment";
    }
  }

  if (options.reconfigure !== false) reconfigureHttpDispatcher();
  return currentEffective(source);
}

/** Server start: apply the saved setting before the dispatcher is first built. */
export function initializeNetworkProxy(): EffectiveNetworkProxy {
  return applyNetworkProxySettings(readNetworkProxySettings(), { reconfigure: false });
}

/** The proxy in effect now, without changing anything. */
export function readEffectiveNetworkProxy(): EffectiveNetworkProxy {
  const settings = readNetworkProxySettings();
  if (settings.enabled && normalizeProxyUrl(settings.url).ok) return currentEffective("settings");
  const baseline = envBaseline();
  const hasEnvProxy = Boolean(baseline.HTTP_PROXY || baseline.HTTPS_PROXY || baseline.http_proxy || baseline.https_proxy);
  if (hasEnvProxy) return currentEffective("environment");
  return currentEffective(readPiSettingsHttpProxy() ? "pi-settings" : "none");
}
