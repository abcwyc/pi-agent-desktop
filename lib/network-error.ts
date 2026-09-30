/**
 * Undici's fetch() collapses almost every network failure into
 * `TypeError: fetch failed`. The actionable detail (TLS, DNS, ECONNREFUSED,
 * ENETUNREACH, …) lives on `error.cause`. Walk the cause chain so API routes
 * can surface it — especially for corporate intranet relays with private CAs.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function codeOf(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" && error.code ? error.code : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function collectCauses(error: unknown): unknown[] {
  const seen = new Set<unknown>();
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = isRecord(current) ? current.cause : undefined;
  }
  return chain;
}

function hintForCode(code: string | undefined, message: string): string | undefined {
  const lower = message.toLowerCase();
  if (
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
    || code === "CERT_HAS_EXPIRED"
    || code === "DEPTH_ZERO_SELF_SIGNED_CERT"
    || code === "SELF_SIGNED_CERT_IN_CHAIN"
    || code === "ERR_TLS_CERT_ALTNAME_INVALID"
    || lower.includes("unable to verify")
    || lower.includes("self-signed")
    || lower.includes("certificate")
  ) {
    return "TLS certificate was rejected. For a company CA, set NODE_EXTRA_CA_CERTS to the PEM file and restart the app.";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "DNS lookup failed. Check the Base URL host name.";
  }
  if (code === "ECONNREFUSED") {
    return "Connection refused. Check that the relay is reachable from this machine.";
  }
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH") {
    return "Network unreachable. If this is an IPv6 address, try an IPv4 Base URL or configure HTTP_PROXY/HTTPS_PROXY.";
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return "Connection timed out. Check the Base URL, proxy, and firewall.";
  }
  return undefined;
}

/** Flatten a fetch/network error into a single operator-facing message. */
export function formatNetworkError(error: unknown): string {
  const chain = collectCauses(error);
  const parts: string[] = [];
  for (const entry of chain) {
    const message = messageOf(entry).trim();
    const code = codeOf(entry);
    const piece = code && !message.includes(code) ? `${message} (${code})` : message;
    if (piece && !parts.includes(piece)) parts.push(piece);
  }

  const root = chain[chain.length - 1] ?? error;
  const hint = hintForCode(codeOf(root), messageOf(root));
  if (hint && !parts.some((part) => part.includes(hint))) parts.push(hint);

  return parts.join(": ") || "Unknown network error";
}
