import { MAX_PLAINTEXT } from "./noise.ts";

/**
 * What travels inside the encrypted channel between the phone shell and the
 * desktop connector: HTTP requests and responses as numbered streams, so many
 * run at once (the app keeps several SSE streams open). Shared by both ends.
 *
 *   [type: u8][stream: u32 BE][payload]
 *
 * Bodies are split so one frame fits one Noise transport message.
 */

export const FrameType = {
  RequestHead: 1,
  RequestBody: 2,
  RequestEnd: 3,
  ResponseHead: 4,
  ResponseBody: 5,
  ResponseEnd: 6,
  ResponseError: 7,
  Cancel: 8,
  Ping: 9,
  Pong: 10,
  /** Desktop → phone after a pairing handshake: { ok, reason? }. */
  PairResult: 11,
  /**
   * Phone → desktop, the first transport message of a pairing: { name }. IKpsk2
   * mixes the secret in only at the second handshake message, so the desktop's
   * side can finish without the phone holding it; this message, encrypted with
   * keys that depend on the secret, is the proof.
   */
  PairRequest: 12,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export interface Frame {
  type: FrameTypeValue;
  stream: number;
  payload: Uint8Array;
}

export interface RequestHead {
  method: string;
  /** Path and query, always starting with "/". */
  url: string;
  headers: [string, string][];
}

export interface ResponseHead {
  status: number;
  headers: [string, string][];
}

const HEADER = 5;
/** Largest payload of a single frame. */
export const MAX_FRAME_PAYLOAD = MAX_PLAINTEXT - HEADER;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KNOWN_TYPES = new Set<number>(Object.values(FrameType));

export function encodeFrame(type: FrameTypeValue, stream: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > MAX_FRAME_PAYLOAD) throw new RangeError("frame payload too large");
  if (!Number.isInteger(stream) || stream < 0 || stream > 0xffffffff) throw new RangeError("invalid stream id");
  const out = new Uint8Array(HEADER + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, stream);
  out.set(payload, HEADER);
  return out;
}

export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length < HEADER) throw new RangeError("frame too short");
  const type = bytes[0];
  if (!KNOWN_TYPES.has(type)) throw new RangeError(`unknown frame type ${type}`);
  return {
    type: type as FrameTypeValue,
    stream: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1),
    payload: bytes.subarray(HEADER),
  };
}

/**
 * Six digits both ends show while pairing, from the handshake hash: the user checks
 * that the phone in hand is the one asking, not someone who saw the QR code.
 */
export function verificationCode(handshakeHash: Uint8Array): string {
  const view = new DataView(handshakeHash.buffer, handshakeHash.byteOffset, handshakeHash.byteLength);
  return String(view.getUint32(0) % 1_000_000).padStart(6, "0");
}

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function decodeJson<T>(payload: Uint8Array): T {
  return JSON.parse(decoder.decode(payload)) as T;
}

/** Split a body into frame-sized chunks (nothing for an empty body). */
export function* chunkBody(body: Uint8Array): Generator<Uint8Array> {
  for (let offset = 0; offset < body.length; offset += MAX_FRAME_PAYLOAD) {
    yield body.subarray(offset, offset + MAX_FRAME_PAYLOAD);
  }
}

function isHeaderList(value: unknown): value is [string, string][] {
  return Array.isArray(value) && value.length <= 200 && value.every((entry) =>
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string");
}

/** Validate a request head from the other side; null when malformed. */
export function parseRequestHead(payload: Uint8Array): RequestHead | null {
  try {
    const value = decodeJson<Partial<RequestHead>>(payload);
    if (typeof value.method !== "string" || !/^[A-Z]{3,7}$/.test(value.method)) return null;
    // Only origin-relative paths: the connector must never be pointed at another host.
    if (typeof value.url !== "string" || !value.url.startsWith("/") || value.url.startsWith("//") || value.url.length > 8192) return null;
    if (!isHeaderList(value.headers)) return null;
    return { method: value.method, url: value.url, headers: value.headers };
  } catch {
    return null;
  }
}

export function parseResponseHead(payload: Uint8Array): ResponseHead | null {
  try {
    const value = decodeJson<Partial<ResponseHead>>(payload);
    if (typeof value.status !== "number" || value.status < 100 || value.status > 599) return null;
    if (!isHeaderList(value.headers)) return null;
    return { status: value.status, headers: value.headers };
  } catch {
    return null;
  }
}
