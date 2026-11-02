import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * How a request that came through the encrypted relay is told apart from one
 * made on this computer. The connector replays tunneled requests against the
 * local server, so they arrive from 127.0.0.1 like the desktop window's own.
 * It strips any client-supplied relay headers and adds the paired device's id
 * plus a per-process secret; `proxy.ts` accepts the pair as an authenticated
 * remote request and refuses a mark with any other secret.
 *
 * The secret lives on globalThis under a registered symbol, so the proxy and the
 * route handlers (separate module instances in one process) read the same value.
 * Not in process.env: every child process (the agent's shell, terminals, MCP
 * servers) inherits that, and one `env` would put the secret in a transcript.
 */

export const RELAY_MARK_HEADER = "x-pi-relay-mark";
export const RELAY_DEVICE_HEADER = "x-pi-relay-device";
const SECRET_KEY = Symbol.for("pi-web:relay-mark-secret");

export function relayMarkSecret(): string {
  const store = globalThis as unknown as Record<symbol, string | undefined>;
  return store[SECRET_KEY] ??= randomBytes(32).toString("hex");
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export type RelayMark = { deviceId: string } | "forged" | null;

/**
 * null: not a relay request. "forged": carries a relay mark that this process did
 * not issue (refuse it). Otherwise the paired device it came from.
 */
export function readRelayMark(request: Request): RelayMark {
  const mark = request.headers.get(RELAY_MARK_HEADER);
  const device = request.headers.get(RELAY_DEVICE_HEADER);
  if (mark === null && device === null) return null;
  const secret = (globalThis as unknown as Record<symbol, string | undefined>)[SECRET_KEY];
  if (!mark || !device || !secret || !sameSecret(mark, secret)) return "forged";
  // The connector replays from this computer: a mark arriving any other way (another
  // host name, a relaying proxy, Tailscale) did not come from it, whatever the secret.
  if (!cameFromConnector(request)) return "forged";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(device)) return "forged";
  return { deviceId: device };
}

function cameFromConnector(request: Request): boolean {
  let hostname = "";
  try {
    hostname = new URL(`http://${request.headers.get("host") ?? ""}`).hostname;
  } catch {
    return false;
  }
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const loopback = (value: string) => value === "127.0.0.1" || value === "::1" || value === "[::1]" || value === "::ffff:127.0.0.1";
  if (!loopback(hostname)) return false;
  if (forwardedFor && !loopback(forwardedFor)) return false;
  for (const name of request.headers.keys()) if (name.toLowerCase().startsWith("tailscale-")) return false;
  return true;
}

/** Whether the request claims to come through the relay at all (valid or not). */
export function hasRelayMark(request: Request): boolean {
  return request.headers.has(RELAY_MARK_HEADER) || request.headers.has(RELAY_DEVICE_HEADER);
}
