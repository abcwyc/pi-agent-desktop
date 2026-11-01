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
/** Serve marks public (Funnel) traffic with this header, and strips any copy a client sends. */
export const TAILSCALE_FUNNEL_HEADER = "tailscale-funnel-request";

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
 * Serve sends a non-ASCII login RFC 2047 Q-encoded (`=?utf-8?q?j=C3=B6rg@…?=`,
 * `encTailscaleHeaderValue` in tailscale's ipn/ipnlocal/serve.go); ASCII passes
 * through as is. Anything that does not decode cleanly is returned unchanged,
 * so it simply fails to match the allow list.
 */
export function decodeTailscaleHeaderValue(value: string): string {
  const match = /^=\?utf-8\?q\?(.*)\?=$/i.exec(value.trim());
  if (!match) return value;
  const text = match[1].replace(/_/g, " ");
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "=" && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i));
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return value;
  }
}

/**
 * Whether a request on the tailnet name may go on: Tailscale vouched for the
 * user, and the user is on the list when there is one.
 */
export function isRemoteAccessRequestAuthorized(request: Request, config: RemoteAccessConfig): boolean {
  if (!isRemoteAccessHost(request, config)) return false;
  const raw = request.headers.get(TAILSCALE_USER_LOGIN_HEADER)?.trim();
  if (!raw) return false;
  const login = decodeTailscaleHeaderValue(raw).toLowerCase();
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

export function isTailscaleFunnelRequest(request: Request): boolean {
  return request.headers.has(TAILSCALE_FUNNEL_HEADER);
}

function isLoopbackAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "");
  return bare === "::1" || (isIP(bare) === 4 && bare.startsWith("127."));
}

/**
 * Whether a proxy relayed this request from another machine. Next fills in
 * X-Forwarded-For with the socket address (127.0.0.1 for this computer) when
 * the request has none, and keeps a proxy's value; Tailscale Serve overwrites
 * it with the visitor's tailnet address. The server binds 127.0.0.1, so a
 * non-loopback first hop can only have come through a proxy. (A local process
 * could forge one, but it is already on this computer.)
 */
export function isRelayedFromAnotherMachine(request: Request): boolean {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return Boolean(first) && !isLoopbackAddress(first!);
}

/**
 * A request from this computer: a loopback Host, not relayed from another
 * machine, and nothing Tailscale Serve adds. Serve routes by TLS SNI and passes
 * the client's Host through, so the Host alone proves nothing.
 *
 * This guards the actions that change who can reach Pi (the remote-access
 * setting, unlocking a chat). It is not a sandbox for an allowed phone, which
 * reaches the same terminals and sessions as this computer: a tailnet login on
 * the allow list is treated as the owner.
 */
export function isLocalRequest(request: Request): boolean {
  const hostname = requestHostname(request)?.replace(/^\[|\]$/g, "");
  if (!hostname) return false;
  const loopback = hostname === "localhost"
    || hostname.endsWith(".localhost")
    || isLoopbackAddress(hostname);
  return loopback
    && !isRelayedFromAnotherMachine(request)
    && !request.headers.has(TAILSCALE_USER_LOGIN_HEADER)
    && !isTailscaleFunnelRequest(request);
}

/** The decoded Tailscale login Serve vouched for, or null (this computer, a tagged device). */
export function tailscaleLoginOf(request: Request): string | null {
  const raw = request.headers.get(TAILSCALE_USER_LOGIN_HEADER)?.trim();
  return raw ? decodeTailscaleHeaderValue(raw).toLowerCase() : null;
}

/** Whether the saved setting still lets this login in (push subscriptions are checked on each send). */
export function isTailscaleLoginAllowed(login: string, settingsPath = remoteAccessSettingsPath()): boolean {
  const config = readRemoteAccessConfig(settingsPath);
  if (!config) return false;
  return config.logins.length === 0 || config.logins.includes(login.toLowerCase());
}

// What `tailscale status` reports for a tagged node's login; never a person.
const TAGGED_LOGIN = "tagged-devices";

/**
 * Validate a `PUT /api/remote-access` body. An empty allow list lets in every
 * signed-in user of the tailnet, which on a shared tailnet hands each member a
 * shell here, so it has to be asked for (`anyTailnetUser: true`), never fallen into.
 */
export function parseRemoteAccessUpdate(body: unknown):
  | { ok: true; config: RemoteAccessConfig | null }
  | { ok: false; error: string } {
  const record = (body && typeof body === "object" ? body : {}) as { hostname?: unknown; logins?: unknown; anyTailnetUser?: unknown };
  if (record.hostname === null) return { ok: true, config: null };
  const hostname = normalizeRemoteHostname(record.hostname);
  if (!hostname) return { ok: false, error: "hostname must be a DNS name such as mac.tail1234.ts.net" };
  if (record.logins !== undefined
    && (!Array.isArray(record.logins) || record.logins.some((login) => typeof login !== "string"))) {
    return { ok: false, error: "logins must be a list of strings" };
  }
  const logins = normalizeLogins(record.logins);
  if (logins.includes(TAGGED_LOGIN)) return { ok: false, error: "tagged devices carry no Tailscale identity; list a person's login" };
  if (logins.length === 0 && record.anyTailnetUser !== true) {
    return { ok: false, error: "name at least one Tailscale login, or set anyTailnetUser to let in every tailnet user" };
  }
  return { ok: true, config: { hostname, logins } };
}
