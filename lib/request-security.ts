import { isIP } from "node:net";
import {
  isRelayedFromAnotherMachine,
  isRemoteAccessOrigin,
  isRemoteAccessRequestAuthorized,
  readRemoteAccessConfig,
  type RemoteAccessConfig,
} from "./remote-access.ts";

function normalizeHostname(value: string): string {
  const unbracketed = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  return unbracketed.toLowerCase().replace(/\.$/, "");
}

function hostnameFromAuthority(value: string): string | null {
  if (!value || /[\s/@\\]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}

function normalizeAuthority(value: string): string | null {
  if (!value || /[\s/@\\]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    const hostname = normalizeHostname(parsed.hostname);
    return parsed.port ? `${hostname}:${parsed.port}` : hostname;
  } catch {
    return null;
  }
}

function normalizeConfiguredHostname(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return isIP(trimmed) ? normalizeHostname(trimmed) : hostnameFromAuthority(trimmed);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function isLoopbackIp(hostname: string): boolean {
  return hostname === "::1" || (isIP(hostname) === 4 && hostname.startsWith("127."));
}

/** Started to listen beyond loopback (`dev:lan`, `pi-web --hostname 0.0.0.0`): other machines connect directly. */
function isListeningBeyondLoopback(): boolean {
  const configured = process.env.PI_WEB_HOSTNAME?.trim().toLowerCase();
  if (!configured) return false;
  const bare = configured.replace(/^\[|\]$/g, "");
  return !(bare === "localhost" || isLoopbackIp(bare));
}

function configuredHostnamesFromEnvironment(): string[] {
  return [
    process.env.PI_WEB_HOSTNAME,
    ...(process.env.PI_WEB_ALLOWED_HOSTS?.split(",") ?? []),
  ].filter((value): value is string => Boolean(value?.trim()));
}

function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getRequestOrigin(request: Request): string | null {
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host");
  return host ? canonicalOrigin(`${requestUrl.protocol}//${host}`) : null;
}

function isPdfFileReadUrl(url: URL): boolean {
  if (!url.pathname.startsWith("/api/files/") || url.searchParams.get("type") !== "read") return false;
  const lastSegment = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(lastSegment).toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

/**
 * A top-level GET the user clicked can arrive marked cross-site with no Origin
 * when the page holding the link has an opaque origin: a PWA's own window
 * opening the session export, or Android Chrome's `data:` placeholder for a PDF
 * it will not render in the viewer's iframe (#1298). Only routes with no side
 * effect whose response cannot run script in the Pi Web origin qualify: the
 * export page (framing denied) and `type=read` of a `.pdf`, which the route
 * always serves as `application/pdf` with nosniff. The opening page cannot
 * read either response.
 */
function isUserInitiatedDocumentNavigation(request: Request): boolean {
  if (
    request.method !== "GET"
    || request.headers.get("sec-fetch-mode") !== "navigate"
    || request.headers.get("sec-fetch-dest") !== "document"
    || request.headers.get("sec-fetch-user") !== "?1"
  ) {
    return false;
  }

  try {
    const url = new URL(request.url);
    return /^\/api\/sessions\/[^/]+\/export$/.test(url.pathname) || isPdfFileReadUrl(url);
  } catch {
    return false;
  }
}

/**
 * Only trust local names, IP literals, or the hostname explicitly selected by
 * the operator. IP literals preserve LAN access but cannot be DNS-rebound
 * because the browser keeps the literal address in the Host header.
 */
export function isApiRequestHostAllowed(
  request: Request,
  configuredHostnames = configuredHostnamesFromEnvironment(),
  remoteAccess: RemoteAccessConfig | null = readRemoteAccessConfig(),
): boolean {
  const host = request.headers.get("host");
  const hostname = host ? hostnameFromAuthority(host) : null;
  if (!hostname) return false;
  // The tailnet name from Settings › Remote access: only a user Tailscale vouched for,
  // even when PI_WEB_ALLOWED_HOSTS also names it.
  if (remoteAccess !== null && hostname === remoteAccess.hostname) {
    return isRemoteAccessRequestAuthorized(request, remoteAccess);
  }
  // Tailscale Serve (or any proxy) passes the client's Host through, so a relayed
  // request can claim to be local. A loopback Host is trusted only from this computer,
  // and an IP literal from another machine only when the server listens on the network.
  const relayed = isRelayedFromAnotherMachine(request);
  if (isLoopbackHostname(hostname) || isLoopbackIp(hostname)) return !relayed;
  if (isIP(hostname)) return !relayed || isListeningBeyondLoopback();

  return configuredHostnames.some(
    (configured) => normalizeConfiguredHostname(configured) === hostname,
  );
}

/**
 * A relay can report the external scheme in `x-forwarded-proto` while rewriting
 * `Origin` onto the backend authority, so the two disagree on the scheme alone
 * for a request that really is same-origin (Azure Dev Tunnels does this). Accept
 * that pairing only when the Origin's authority still equals the Host header,
 * a proxy is in front, and Fetch Metadata still reports a same-origin request.
 */
function isProxyRewrittenSameOrigin(request: Request, origin: string): boolean {
  if (
    request.headers.get("sec-fetch-site") !== "same-origin"
    || !request.headers.get("x-forwarded-proto")
  ) return false;

  const host = request.headers.get("host");
  if (!host) return false;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  const originAuthority = normalizeAuthority(originHost);
  return originAuthority !== null && originAuthority === normalizeAuthority(host);
}

/** Reject browser cross-site API requests while preserving non-browser clients. */
export function isApiRequestOriginAllowed(
  request: Request,
  remoteAccess: RemoteAccessConfig | null = readRemoteAccessConfig(),
): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (!origin) return true;

  const requestOrigin = getRequestOrigin(request);
  if (requestOrigin !== null && canonicalOrigin(origin) === requestOrigin) return true;
  if (isRemoteAccessOrigin(origin, request, remoteAccess)) return true;

  return isProxyRewrittenSameOrigin(request, origin);
}

export function shouldCheckApiRequestOrigin(request: Request): boolean {
  return request.headers.has("origin") || request.headers.has("sec-fetch-site");
}

export function isApiRequestAllowed(
  request: Request,
  configuredHostnames = configuredHostnamesFromEnvironment(),
): boolean {
  if (!isApiRequestHostAllowed(request, configuredHostnames)) return false;
  if (isUserInitiatedDocumentNavigation(request)) return true;
  return !shouldCheckApiRequestOrigin(request) || isApiRequestOriginAllowed(request);
}

export function hasJsonContentType(request: Request): boolean {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json"
    || Boolean(mediaType?.startsWith("application/") && mediaType.endsWith("+json"));
}
