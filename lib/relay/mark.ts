import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * How a request that came through the encrypted relay is told apart from one
 * made on this computer. The connector replays tunneled requests against the
 * local server, so they arrive from 127.0.0.1 like the desktop window's own.
 * It strips any client-supplied relay headers and adds the paired device's id
 * plus a per-process secret; `proxy.ts` accepts the pair as an authenticated
 * remote request and refuses a mark with any other secret.
 *
 * The secret lives in process.env so the proxy and route handlers (separate
 * module instances in one process) read the same value.
 */

export const RELAY_MARK_HEADER = "x-pi-relay-mark";
export const RELAY_DEVICE_HEADER = "x-pi-relay-device";
const SECRET_ENV = "PI_RELAY_MARK_SECRET";

export function relayMarkSecret(env: NodeJS.ProcessEnv = process.env): string {
  const existing = env[SECRET_ENV];
  if (existing && existing.length >= 32) return existing;
  const secret = randomBytes(32).toString("hex");
  env[SECRET_ENV] = secret;
  return secret;
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export type RelayMark = { deviceId: string } | "forged" | null;

/**
 * null: not a relay request. "forged": carries a relay mark that this process did
 * not issue (refuse it). Otherwise the paired device it came from.
 */
export function readRelayMark(request: Request, env: NodeJS.ProcessEnv = process.env): RelayMark {
  const mark = request.headers.get(RELAY_MARK_HEADER);
  const device = request.headers.get(RELAY_DEVICE_HEADER);
  if (mark === null && device === null) return null;
  const secret = env[SECRET_ENV];
  if (!mark || !device || !secret || !sameSecret(mark, secret)) return "forged";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(device)) return "forged";
  return { deviceId: device };
}

/** Whether the request claims to come through the relay at all (valid or not). */
export function hasRelayMark(request: Request): boolean {
  return request.headers.has(RELAY_MARK_HEADER) || request.headers.has(RELAY_DEVICE_HEADER);
}
