import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file.ts";
import { base64UrlDecode, base64UrlEncode, exportPrivateKey, generateKeyPair } from "./noise.ts";

/**
 * What the desktop keeps for the relay, each file private (0600) under
 * `<agent dir>/pi-web/`:
 * - relay.json: relay and entry URLs, the switch, and the admin token until the
 *   relay has registered this desktop;
 * - relay-identity.json: the Noise static key phones pin, and the ECDSA key the
 *   relay knows this desktop by;
 * - relay-devices.json: paired phones' static public keys.
 */

export interface RelayConfig {
  enabled: boolean;
  /** wss://relay.example.com (ws:// only for a relay on this computer, in tests). */
  url: string;
  /** https://pi.example.com, the static host that serves the phone shell (an origin root). */
  entryUrl: string;
  /** Needed once, for the relay to register this desktop; dropped after. */
  adminToken?: string;
}

export interface RelayIdentity {
  /** Raw X25519 private key for Noise. */
  noisePrivate: Uint8Array;
  noisePublic: Uint8Array;
  /** ECDSA P-256 key pair (JWK) the relay authenticates this desktop with. */
  signingPrivate: JsonWebKey;
  signingPublicSpki: Uint8Array;
}

export interface PairedDevice {
  id: string;
  name: string;
  /** base64url X25519 public key. */
  publicKey: string;
  pairedAt: string;
  lastSeenAt?: string;
}

export function relayDir(agentDir: string): string {
  return join(agentDir, "pi-web");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writePrivateFileAtomicSync(join(dir, name), JSON.stringify(value, null, 2));
}

function isLoopbackHost(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "::1" || (isIP(bare) === 4 && bare.startsWith("127."));
}

/** wss:// (or ws:// for a relay on this computer); no query or fragment. Null when invalid. */
export function normalizeRelayUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopbackHost(url.hostname))) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * The entry host serves the phone shell and must be an origin root: the app's
 * root-relative URLs (/_next/…, /api/…) have to stay inside the tunnel worker's
 * scope. https only (http on this computer, for tests).
 */
export function normalizeEntryUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function readRelayConfig(dir: string): RelayConfig | null {
  const value = readJson(join(dir, "relay.json")) as Partial<RelayConfig> | null;
  if (!value || typeof value !== "object") return null;
  const url = normalizeRelayUrl(value.url);
  const entryUrl = normalizeEntryUrl(value.entryUrl);
  if (!url || !entryUrl) return null;
  return {
    enabled: value.enabled === true,
    url,
    entryUrl,
    ...(typeof value.adminToken === "string" && value.adminToken ? { adminToken: value.adminToken } : {}),
  };
}

export function writeRelayConfig(dir: string, config: RelayConfig): void {
  writeJson(dir, "relay.json", { version: 1, ...config });
}

export async function loadOrCreateIdentity(dir: string): Promise<RelayIdentity> {
  const stored = readJson(join(dir, "relay-identity.json")) as {
    noisePrivate?: string; noisePublic?: string; signingPrivate?: JsonWebKey; signingPublicSpki?: string;
  } | null;
  if (stored?.noisePrivate && stored.noisePublic && stored.signingPrivate && stored.signingPublicSpki) {
    return {
      noisePrivate: base64UrlDecode(stored.noisePrivate),
      noisePublic: base64UrlDecode(stored.noisePublic),
      signingPrivate: stored.signingPrivate,
      signingPublicSpki: base64UrlDecode(stored.signingPublicSpki),
    };
  }
  const noise = await generateKeyPair(true);
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const identity: RelayIdentity = {
    noisePrivate: await exportPrivateKey(noise),
    noisePublic: noise.publicKey,
    signingPrivate: await crypto.subtle.exportKey("jwk", signing.privateKey),
    signingPublicSpki: new Uint8Array(await crypto.subtle.exportKey("spki", signing.publicKey)),
  };
  writeJson(dir, "relay-identity.json", {
    version: 1,
    noisePrivate: base64UrlEncode(identity.noisePrivate),
    noisePublic: base64UrlEncode(identity.noisePublic),
    signingPrivate: identity.signingPrivate,
    signingPublicSpki: base64UrlEncode(identity.signingPublicSpki),
  });
  return identity;
}

/** The relay's name for this desktop: matches relay/server.mjs agentIdFor(). */
export function agentIdFor(signingPublicSpki: Uint8Array): string {
  return createHash("sha256").update(signingPublicSpki).digest("base64url").slice(0, 32);
}

export function deviceIdFor(publicKey: Uint8Array): string {
  return createHash("sha256").update(publicKey).digest("base64url").slice(0, 16);
}

export function readDevices(dir: string): PairedDevice[] {
  const value = readJson(join(dir, "relay-devices.json")) as { devices?: unknown } | null;
  if (!Array.isArray(value?.devices)) return [];
  return value.devices.filter((d): d is PairedDevice =>
    !!d && typeof d === "object"
    && typeof (d as PairedDevice).id === "string"
    && typeof (d as PairedDevice).name === "string"
    && typeof (d as PairedDevice).publicKey === "string"
    && typeof (d as PairedDevice).pairedAt === "string");
}

export function writeDevices(dir: string, devices: PairedDevice[]): void {
  writeJson(dir, "relay-devices.json", { version: 1, devices });
}

/** Clean a device name a phone suggested: one short line of text. */
export function cleanDeviceName(value: unknown): string {
  const name = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  return (name || "Phone").slice(0, 60);
}
