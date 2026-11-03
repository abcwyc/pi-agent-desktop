/**
 * Noise Protocol Framework, revision 34: the IK and IKpsk2 handshake patterns
 * with X25519, AES-256-GCM and SHA-256, on WebCrypto alone, so the phone shell
 * and the desktop connector run this same module. Verified byte for byte
 * against the cacophony test vectors (lib/relay/noise.test.mjs).
 *
 * IK: the phone knows the desktop's static key (from pairing) and sends its own,
 * encrypted, in the first message; the desktop accepts only paired devices.
 * IKpsk2: the same, bound to the pairing QR's one-time secret, for pairing.
 * https://noiseprotocol.org/noise.html
 */

const subtle = globalThis.crypto.subtle;

export const DHLEN = 32;
const HASHLEN = 32;
const TAGLEN = 16;
/** Largest Noise message (spec §3). */
export const MAX_MESSAGE = 65535;
/** Largest payload of one transport message. */
export const MAX_PLAINTEXT = MAX_MESSAGE - TAGLEN;
// 2^64 - 1 is reserved; we stop far below it and rekey by reconnecting.
const MAX_NONCE = 2 ** 53 - 1;

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();

export type NoisePattern = "IK" | "IKpsk2";

export interface KeyPair {
  privateKey: CryptoKey;
  /** Raw 32-byte X25519 public key. */
  publicKey: Uint8Array;
}

export class NoiseError extends Error {}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", buffer(data)));
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", buffer(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, buffer(data)));
}

/** Noise HKDF (§4.3): two or three HASHLEN outputs chained from HMAC-SHA256. */
async function hkdf(chainingKey: Uint8Array, ikm: Uint8Array, outputs: 2 | 3): Promise<Uint8Array[]> {
  const temp = await hmac(chainingKey, ikm);
  const out1 = await hmac(temp, Uint8Array.of(1));
  const out2 = await hmac(temp, concat(out1, Uint8Array.of(2)));
  if (outputs === 2) return [out1, out2];
  const out3 = await hmac(temp, concat(out2, Uint8Array.of(3)));
  return [out1, out2, out3];
}

function nonceBytes(n: number): Uint8Array {
  // AESGCM nonce: 32 bits of zeros, then the counter as a 64-bit big-endian integer.
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(n));
  return nonce;
}

// X25519 PKCS#8 wrapper (RFC 8410) around a raw 32-byte private key.
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

export async function generateKeyPair(extractable = false): Promise<KeyPair> {
  const pair = await subtle.generateKey({ name: "X25519" }, extractable, ["deriveBits"]) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle.exportKey("raw", pair.publicKey)) };
}

/** A key pair from a raw private key (test vectors, keys loaded from disk). */
export async function keyPairFromPrivate(raw: Uint8Array, extractable = false): Promise<KeyPair> {
  if (raw.length !== DHLEN) throw new NoiseError("X25519 private key must be 32 bytes");
  const exportable = await subtle.importKey("pkcs8", buffer(concat(PKCS8_PREFIX, raw)), { name: "X25519" }, true, ["deriveBits"]);
  const jwk = await subtle.exportKey("jwk", exportable);
  const publicKey = base64UrlDecode(jwk.x!);
  const privateKey = extractable
    ? exportable
    : await subtle.importKey("pkcs8", buffer(concat(PKCS8_PREFIX, raw)), { name: "X25519" }, false, ["deriveBits"]);
  return { privateKey, publicKey };
}

/** The raw private key of an extractable pair, for storing on the desktop. */
export async function exportPrivateKey(pair: KeyPair): Promise<Uint8Array> {
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  return base64UrlDecode(jwk.d!);
}

async function dh(pair: KeyPair, remotePublic: Uint8Array): Promise<Uint8Array> {
  let out: Uint8Array;
  try {
    const pub = await subtle.importKey("raw", buffer(remotePublic), { name: "X25519" }, true, []);
    out = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: pub }, pair.privateKey, DHLEN * 8));
  } catch {
    // WebCrypto refuses low-order points itself (an all-zero shared secret).
    throw new NoiseError("invalid remote public key");
  }
  // An all-zero result means a low-order public key; refuse it rather than key on zeros.
  if (out.every((b) => b === 0)) throw new NoiseError("invalid remote public key");
  return out;
}

export class CipherState {
  private key: CryptoKey | null = null;
  private n = 0;

  async initializeKey(raw: Uint8Array | null): Promise<void> {
    this.key = raw ? await subtle.importKey("raw", buffer(raw.subarray(0, 32)), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]) : null;
    this.n = 0;
  }

  hasKey(): boolean {
    return this.key !== null;
  }

  async encrypt(ad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    if (!this.key) return plaintext;
    if (this.n >= MAX_NONCE) throw new NoiseError("nonce exhausted");
    // Reserve the nonce before awaiting: two concurrent calls must never share one.
    const n = this.n;
    this.n += 1;
    const out = await subtle.encrypt({ name: "AES-GCM", iv: buffer(nonceBytes(n)), additionalData: buffer(ad) }, this.key, buffer(plaintext));
    return new Uint8Array(out);
  }

  async decrypt(ad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    if (!this.key) return ciphertext;
    if (this.n >= MAX_NONCE) throw new NoiseError("nonce exhausted");
    const n = this.n;
    this.n += 1;
    try {
      const out = await subtle.decrypt({ name: "AES-GCM", iv: buffer(nonceBytes(n)), additionalData: buffer(ad) }, this.key, buffer(ciphertext));
      return new Uint8Array(out);
    } catch {
      // A forged or replayed message does not use up the slot (callers close the
      // session on any failure anyway).
      if (this.n === n + 1) this.n = n;
      throw new NoiseError("decryption failed");
    }
  }
}

class SymmetricState {
  readonly cipher = new CipherState();
  ck: Uint8Array = new Uint8Array(HASHLEN);
  h: Uint8Array = new Uint8Array(HASHLEN);

  async initialize(protocolName: string): Promise<void> {
    const name = encoder.encode(protocolName);
    if (name.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN);
      this.h.set(name);
    } else {
      this.h = await sha256(name);
    }
    this.ck = this.h.slice();
    await this.cipher.initializeKey(null);
  }

  async mixKey(ikm: Uint8Array): Promise<void> {
    const [ck, tempK] = await hkdf(this.ck, ikm, 2);
    this.ck = ck;
    await this.cipher.initializeKey(tempK);
  }

  async mixHash(data: Uint8Array): Promise<void> {
    this.h = await sha256(concat(this.h, data));
  }

  async mixKeyAndHash(ikm: Uint8Array): Promise<void> {
    const [ck, tempH, tempK] = await hkdf(this.ck, ikm, 3);
    this.ck = ck;
    await this.mixHash(tempH);
    await this.cipher.initializeKey(tempK);
  }

  async encryptAndHash(plaintext: Uint8Array): Promise<Uint8Array> {
    const ciphertext = await this.cipher.encrypt(this.h, plaintext);
    await this.mixHash(ciphertext);
    return ciphertext;
  }

  async decryptAndHash(ciphertext: Uint8Array): Promise<Uint8Array> {
    const plaintext = await this.cipher.decrypt(this.h, ciphertext);
    await this.mixHash(ciphertext);
    return plaintext;
  }

  async split(): Promise<[CipherState, CipherState]> {
    const [k1, k2] = await hkdf(this.ck, EMPTY, 2);
    const c1 = new CipherState();
    const c2 = new CipherState();
    await c1.initializeKey(k1);
    await c2.initializeKey(k2);
    return [c1, c2];
  }
}

type Token = "e" | "s" | "ee" | "es" | "se" | "ss" | "psk";

const PATTERNS: Record<NoisePattern, Token[][]> = {
  IK: [["e", "es", "s", "ss"], ["e", "ee", "se"]],
  IKpsk2: [["e", "es", "s", "ss"], ["e", "ee", "se", "psk"]],
};

export interface HandshakeOptions {
  pattern: NoisePattern;
  initiator: boolean;
  prologue: Uint8Array;
  /** Our static key pair. */
  s: KeyPair;
  /** The responder's static public key; the initiator must know it (IK). */
  rs?: Uint8Array;
  /** 32-byte pre-shared key for IKpsk2. */
  psk?: Uint8Array;
  /** Fixed ephemeral key, for test vectors only. */
  e?: KeyPair;
}

/** Transport state after the handshake: one cipher each way. */
export interface Transport {
  send: CipherState;
  receive: CipherState;
  /** The handshake hash, for channel binding. */
  handshakeHash: Uint8Array;
  /** The other side's static public key. */
  remoteStatic: Uint8Array;
}

export class HandshakeState {
  private readonly symmetric = new SymmetricState();
  private readonly messages: Token[][];
  private index = 0;
  private e: KeyPair | null;
  private re: Uint8Array | null = null;
  private rs: Uint8Array | null;
  private readonly hasPsk: boolean;
  private readonly options: HandshakeOptions;

  private constructor(options: HandshakeOptions) {
    this.options = options;
    this.messages = PATTERNS[options.pattern];
    this.e = options.e ?? null;
    this.rs = options.rs ?? null;
    this.hasPsk = options.pattern.includes("psk");
    if (this.hasPsk && options.psk?.length !== 32) throw new NoiseError("psk must be 32 bytes");
    if (options.initiator && !this.rs) throw new NoiseError("IK initiator needs the responder's static key");
  }

  static async create(options: HandshakeOptions): Promise<HandshakeState> {
    const state = new HandshakeState(options);
    await state.symmetric.initialize(`Noise_${options.pattern}_25519_AESGCM_SHA256`);
    await state.symmetric.mixHash(options.prologue);
    // IK pre-message: <- s
    await state.symmetric.mixHash(options.initiator ? state.rs! : options.s.publicKey);
    return state;
  }

  /** Whose turn it is: the initiator writes message 0, the responder message 1. */
  private ensureTurn(writing: boolean): Token[] {
    const tokens = this.messages[this.index];
    if (!tokens) throw new NoiseError("handshake already finished");
    const initiatorWrites = this.index % 2 === 0;
    if (writing !== (initiatorWrites === this.options.initiator)) throw new NoiseError("out-of-turn handshake message");
    return tokens;
  }

  private async mixDh(token: "ee" | "es" | "se" | "ss"): Promise<void> {
    const { initiator, s } = this.options;
    // es = DH(initiator e, responder s), seen from either side, and so on.
    const local = token === "ee" ? this.e! : token === "ss" ? s
      : token === "es" ? (initiator ? this.e! : s) : (initiator ? s : this.e!);
    const remote = token === "ee" ? this.re! : token === "ss" ? this.rs!
      : token === "es" ? (initiator ? this.rs! : this.re!) : (initiator ? this.re! : this.rs!);
    await this.symmetric.mixKey(await dh(local, remote));
  }

  async writeMessage(payload: Uint8Array = EMPTY): Promise<Uint8Array> {
    const tokens = this.ensureTurn(true);
    const parts: Uint8Array[] = [];
    for (const token of tokens) {
      if (token === "e") {
        this.e ??= await generateKeyPair();
        parts.push(this.e.publicKey);
        await this.symmetric.mixHash(this.e.publicKey);
        if (this.hasPsk) await this.symmetric.mixKey(this.e.publicKey);
      } else if (token === "s") {
        parts.push(await this.symmetric.encryptAndHash(this.options.s.publicKey));
      } else if (token === "psk") {
        await this.symmetric.mixKeyAndHash(this.options.psk!);
      } else {
        await this.mixDh(token);
      }
    }
    parts.push(await this.symmetric.encryptAndHash(payload));
    this.index += 1;
    const message = concat(...parts);
    if (message.length > MAX_MESSAGE) throw new NoiseError("handshake message too large");
    return message;
  }

  async readMessage(message: Uint8Array): Promise<Uint8Array> {
    const tokens = this.ensureTurn(false);
    if (message.length > MAX_MESSAGE) throw new NoiseError("handshake message too large");
    let offset = 0;
    const take = (n: number) => {
      if (offset + n > message.length) throw new NoiseError("handshake message too short");
      const out = message.subarray(offset, offset + n);
      offset += n;
      return out;
    };
    for (const token of tokens) {
      if (token === "e") {
        this.re = take(DHLEN).slice();
        await this.symmetric.mixHash(this.re);
        if (this.hasPsk) await this.symmetric.mixKey(this.re);
      } else if (token === "s") {
        const length = this.symmetric.cipher.hasKey() ? DHLEN + TAGLEN : DHLEN;
        this.rs = (await this.symmetric.decryptAndHash(take(length))).slice();
      } else if (token === "psk") {
        await this.symmetric.mixKeyAndHash(this.options.psk!);
      } else {
        await this.mixDh(token);
      }
    }
    const payload = await this.symmetric.decryptAndHash(message.subarray(offset));
    this.index += 1;
    return payload;
  }

  /** The other side's static key once it has been received (after message 0 for the responder). */
  get remoteStatic(): Uint8Array | null {
    return this.rs;
  }

  isFinished(): boolean {
    return this.index >= this.messages.length;
  }

  async split(): Promise<Transport> {
    if (!this.isFinished()) throw new NoiseError("handshake not finished");
    const [c1, c2] = await this.symmetric.split();
    return {
      send: this.options.initiator ? c1 : c2,
      receive: this.options.initiator ? c2 : c1,
      handshakeHash: this.symmetric.h.slice(),
      remoteStatic: this.rs!,
    };
  }
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
