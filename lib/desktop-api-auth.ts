import { createHash, timingSafeEqual } from "node:crypto";
import {
  DESKTOP_API_TOKEN_ENV,
  DESKTOP_API_TOKEN_HEADER,
} from "./desktop-api.ts";
import { isApiRequestAllowed } from "./request-security.ts";
import { hasRelayMark } from "./relay/mark.ts";

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function hasLoopbackHost(request: Request): boolean {
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
    return hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname === "127.0.0.1"
      || hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * Authorize filesystem operations whose paths came from a native dialog.
 *
 * Host/origin validation remains the first line of defense. The per-process
 * desktop token additionally keeps these deliberately broad filesystem APIs
 * unavailable to normal browser and LAN clients.
 */
export function isDesktopApiRequestAllowed(
  request: Request,
  expectedToken = process.env[DESKTOP_API_TOKEN_ENV],
): boolean {
  if (!isApiRequestAllowed(request)) return false;
  if (!hasLoopbackHost(request)) return false;
  // A phone's request replayed by the relay connector arrives from loopback too.
  if (hasRelayMark(request)) return false;

  const expected = expectedToken?.trim();
  const provided = request.headers.get(DESKTOP_API_TOKEN_HEADER)?.trim();
  if (!expected || expected.length < 32 || !provided) return false;

  return timingSafeEqual(tokenDigest(expected), tokenDigest(provided));
}
