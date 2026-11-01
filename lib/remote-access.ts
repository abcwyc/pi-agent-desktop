import { mkdirSync, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { userHome } from "./user-home.ts";

/**
 * Remote access through Tailscale Serve.
 *
 * The server keeps listening on 127.0.0.1. `tailscale serve` on this computer
 * proxies `https://<machine>.<tailnet>.ts.net` to that port, so a phone in the
 * user's tailnet reaches Pi without the port ever being opened to a network.
 *
 * Serve keeps the original Host header, which request-security rejects unless
 * the operator named it. Naming it here is that opt-in, and it comes with a
 * second check: a request on that host must carry the `Tailscale-User-Login`
 * header. Serve adds it for signed-in tailnet users only and strips any copy a
 * client sends; Funnel (public) traffic and tagged devices never get one. So
 * turning on Funnel by mistake, or a local process forging the Host header,
 * does not open the server.
 *
 * The file lives next to Pi Web's other settings (`pi-web/settings.json`), but
 * is resolved without the pi SDK because `proxy.ts` reads it on every request.
 */

export const TAILSCALE_USER_LOGIN_HEADER = "tailscale-user-login";

export interface RemoteAccessConfig {
  /** The tailnet name of this computer, e.g. `mac.tail1234.ts.net`. */
  hostname: string;
  /** Tailscale logins allowed in; empty lets in every signed-in tailnet user. */
  logins: string[];
}

export function remoteAccessSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configured
    ? configured === "~" || configured.startsWith("~/")
      ? join(userHome(), configured.slice(1))
      : configured
    : join(userHome(), ".pi", "agent");
  return join(agentDir, "pi-web", "settings.json");
}

/**
 * Reduce what the user typed (`https://Mac.tail1234.ts.net/`, with or without a
 * port) to a bare DNS name. IP literals and loopback names are refused: they
 * are already allowed, and naming one would not mean "through Tailscale".
 */
export function normalizeRemoteHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let hostname: string;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
      return null;
    }
    hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  if (!hostname.includes(".") || isIP(hostname.replace(/^\[|\]$/g, ""))) return null;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return null;
  if (!/^[a-z0-9.-]+$/.test(hostname) || hostname.split(".").some((label) => !label)) return null;
  return hostname;
}

function normalizeLogins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const logins = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(logins)];
}

function parseRemoteAccess(value: unknown): RemoteAccessConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { hostname?: unknown; logins?: unknown };
  const hostname = normalizeRemoteHostname(record.hostname);
  return hostname ? { hostname, logins: normalizeLogins(record.logins) } : null;
}

let cache: { path: string; mtimeMs: number; size: number; config: RemoteAccessConfig | null } | null = null;

/**
 * The saved remote-access setting, or null when it is off. Read on every
 * request, so the parsed file is cached until its mtime or size changes. A
 * missing or unreadable file means off: failing closed only ever costs the
 * phone its access.
 */
export function readRemoteAccessConfig(settingsPath = remoteAccessSettingsPath()): RemoteAccessConfig | null {
  let stat;
  try {
    stat = statSync(settingsPath);
  } catch {
    cache = null;
    return null;
  }
  if (cache && cache.path === settingsPath && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.config;
  }
  let config: RemoteAccessConfig | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parseRemoteAccess((parsed as { remoteAccess?: unknown }).remoteAccess);
    }
  } catch {
    config = null;
  }
  cache = { path: settingsPath, mtimeMs: stat.mtimeMs, size: stat.size, config };
  return config;
}

/** Save the setting (null turns it off), leaving the file's other keys alone. */
export function writeRemoteAccessConfig(
  config: RemoteAccessConfig | null,
  settingsPath = remoteAccessSettingsPath(),
): RemoteAccessConfig | null {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
    else throw new Error("Invalid Pi Web settings: expected an object");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = { ...stored, version: 1 } as Record<string, unknown>;
  if (config) next.remoteAccess = { hostname: config.hostname, logins: normalizeLogins(config.logins) };
  else delete next.remoteAccess;
  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify(next, null, 2));
  cache = null;
  return readRemoteAccessConfig(settingsPath);
}

function requestHostname(request: Request): string | null {
  const host = request.headers.get("host");
  if (!host || /[\s/@\\]/.test(host)) return null;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** Whether the request came in on the configured tailnet name. */
export function isRemoteAccessHost(request: Request, config: RemoteAccessConfig | null): boolean {
  return Boolean(config) && requestHostname(request) === config!.hostname;
}

/**
 * Whether a request on the tailnet name may go on: Tailscale vouched for the
 * user, and the user is on the list when there is one.
 */
export function isRemoteAccessRequestAuthorized(request: Request, config: RemoteAccessConfig): boolean {
  if (!isRemoteAccessHost(request, config)) return false;
  const login = request.headers.get(TAILSCALE_USER_LOGIN_HEADER)?.trim().toLowerCase();
  if (!login) return false;
  return config.logins.length === 0 || config.logins.includes(login);
}

/**
 * Serve terminates TLS, so the browser's Origin is `https://<tailnet name>`
 * while the server itself sees plain HTTP. That pairing is same-origin.
 */
export function isRemoteAccessOrigin(origin: string, request: Request, config: RemoteAccessConfig | null): boolean {
  if (!config || !isRemoteAccessHost(request, config)) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:"
      && parsed.hostname.toLowerCase() === config.hostname
      && (parsed.port === "" || parsed.port === "443");
  } catch {
    return false;
  }
}
