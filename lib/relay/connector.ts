import { randomBytes } from "node:crypto";
import { DESKTOP_API_TOKEN_HEADER } from "../desktop-api.ts";
import {
  FrameType,
  MAX_FRAME_PAYLOAD,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJson,
  parseRequestHead,
  type FrameTypeValue,
  type RequestHead,
} from "./frames.ts";
import { RELAY_DEVICE_HEADER, RELAY_MARK_HEADER, relayMarkSecret } from "./mark.ts";
import {
  HandshakeState,
  NoiseError,
  base64UrlEncode,
  keyPairFromPrivate,
  type KeyPair,
  type Transport,
} from "./noise.ts";
import {
  agentIdFor,
  cleanDeviceName,
  deviceIdFor,
  readDevices,
  writeDevices,
  writeRelayConfig,
  type PairedDevice,
  type RelayConfig,
  type RelayIdentity,
} from "./store.ts";

/**
 * The desktop end of the relay (docs/remote-relay.md). Keeps one outbound
 * connection to the relay, runs a Noise handshake with each phone, accepts only
 * paired devices (or a phone holding a live pairing secret, after the user
 * approves it on this computer), and replays the phone's tunneled requests
 * against the local Pi server with the relay mark (lib/relay/mark.ts).
 */

const KIND_OPEN = 1;
const KIND_DATA = 2;
const KIND_CLOSE = 3;
const CLIENT_ID_BYTES = 16;
/** First byte of a phone's first message. */
export const MODE_SESSION = 1;
export const MODE_PAIR = 2;
export const PAIRING_ID_BYTES = 8;
export const PAIRING_TTL_MS = 5 * 60_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_STREAMS = 64;
const MAX_REQUEST_BODY = 64 * 1024 * 1024;
const SEND_BUFFER_LIMIT = 4 * 1024 * 1024;
const FAILED_HANDSHAKES_PER_MINUTE = 30;
const EMPTY = new Uint8Array(0);

// Hop-by-hop headers, anything that would let a phone claim another identity
// (forwarding, Tailscale, relay mark, desktop token), and what the tunnel
// rebuilds (cookies are not carried; device keys replace the web password).
const DROP_REQUEST_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer",
  "transfer-encoding", "upgrade", "content-length", "accept-encoding", "cookie", "origin", "referer",
  "forwarded", "x-real-ip", "authorization", DESKTOP_API_TOKEN_HEADER, RELAY_MARK_HEADER, RELAY_DEVICE_HEADER,
]);
const DROP_REQUEST_PREFIXES = ["sec-fetch-", "x-forwarded-", "tailscale-", "x-pi-relay-"];
const DROP_RESPONSE_HEADERS = new Set([
  "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie", "trailer",
]);

export function sanitizeRequestHeaders(headers: [string, string][]): [string, string][] {
  return headers.filter(([name]) => {
    const lower = name.toLowerCase();
    return !DROP_REQUEST_HEADERS.has(lower) && !DROP_REQUEST_PREFIXES.some((prefix) => lower.startsWith(prefix));
  });
}

export function sanitizeResponseHeaders(headers: Headers): [string, string][] {
  return [...headers].filter(([name]) => !DROP_RESPONSE_HEADERS.has(name.toLowerCase()));
}

export function relayPrologue(agentId: string): Uint8Array {
  return new TextEncoder().encode(`pi-relay/1\n${agentId}`);
}

export type RelayState = "off" | "connecting" | "online" | "error";

export interface RelayStatus {
  state: RelayState;
  error?: string;
  agentId: string;
  phones: number;
}

export interface PendingPairing {
  id: string;
  name: string;
  deviceId: string;
  requestedAt: number;
}

interface Pairing {
  id: string;
  secret: Uint8Array;
  expiresAt: number;
  used: boolean;
}

interface Stream {
  head: RequestHead | null;
  body: Uint8Array[];
  size: number;
  controller: AbortController;
}

type SocketLike = {
  binaryType: string;
  readyState: number;
  bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void;
};

export interface ConnectorOptions {
  dir: string;
  config: RelayConfig;
  identity: RelayIdentity;
  /** http://127.0.0.1:<port> of this Pi server. */
  localOrigin: () => string;
  WebSocketImpl?: new (url: string) => SocketLike;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  onChange?: () => void;
}

class PhoneSession {
  transport: Transport | null = null;
  deviceId: string | null = null;
  pairing: { pairing: Pairing; phoneKey: Uint8Array; name: string; requestedAt: number } | null = null;
  /** A pairing handshake whose phone has not yet proven it holds the secret. */
  pairingCandidate: { pairing: Pairing; phoneKey: Uint8Array } | null = null;
  readonly streams = new Map<number, Stream>();
  private receiveChain: Promise<void> = Promise.resolve();
  private sendChain: Promise<void> = Promise.resolve();
  closed = false;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly clientId: Uint8Array;
  private readonly connector: RelayConnector;

  constructor(clientId: Uint8Array, connector: RelayConnector) {
    this.clientId = clientId;
    this.connector = connector;
    // Closes a phone that has not finished the handshake, or a pairing phone that
    // finished it but never proved the secret.
    this.timer = setTimeout(() => {
      if (!this.transport || this.pairingCandidate) this.close("handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);
  }

  receive(bytes: Uint8Array): void {
    this.receiveChain = this.receiveChain
      .then(() => this.closed ? undefined : this.connector.handlePhoneMessage(this, bytes))
      .catch((error) => this.close(error instanceof Error ? error.message : String(error)));
  }

  /** Encrypt and send one frame; frames go out in order. */
  send(type: FrameTypeValue, stream: number, payload: Uint8Array = EMPTY): Promise<void> {
    const next = this.sendChain.then(async () => {
      if (this.closed || !this.transport) return;
      const ciphertext = await this.transport.send.encrypt(EMPTY, encodeFrame(type, stream, payload));
      this.connector.sendToPhone(this.clientId, ciphertext);
    });
    this.sendChain = next.catch(() => {});
    return next;
  }

  close(reason: string, notifyRelay = true): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    for (const stream of this.streams.values()) stream.controller.abort();
    this.streams.clear();
    this.connector.forgetSession(this, reason, notifyRelay);
  }
}

export class RelayConnector {
  private socket: SocketLike | null = null;
  private state: RelayState = "off";
  private error: string | undefined;
  private stopped = true;
  private retryMs = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly sessions = new Map<string, PhoneSession>();
  private readonly pairings = new Map<string, Pairing>();
  private failedHandshakes: { start: number; count: number } = { start: 0, count: 0 };
  private staticKey: KeyPair | null = null;
  readonly agentId: string;
  private config: RelayConfig;
  private readonly options: ConnectorOptions;

  constructor(options: ConnectorOptions) {
    this.options = options;
    this.config = options.config;
    this.agentId = agentIdFor(options.identity.signingPublicSpki);
    relayMarkSecret();
  }

  status(): RelayStatus {
    let phones = 0;
    for (const session of this.sessions.values()) if (session.deviceId) phones += 1;
    return { state: this.state, ...(this.error ? { error: this.error } : {}), agentId: this.agentId, phones };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const session of [...this.sessions.values()]) session.close("relay stopped", false);
    this.socket?.close(1000, "stopped");
    this.socket = null;
    this.setState("off");
  }

  private setState(state: RelayState, error?: string): void {
    this.state = state;
    this.error = error;
    this.options.onChange?.();
  }

  private log(line: string): void {
    this.options.log?.(`[relay] ${line}`);
  }

  private connect(): void {
    if (this.stopped) return;
    const WebSocketImpl = this.options.WebSocketImpl ?? (globalThis.WebSocket as unknown as new (url: string) => SocketLike);
    this.setState("connecting");
    let socket: SocketLike;
    try {
      socket = new WebSocketImpl(`${this.config.url}/agent`);
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let ready = false;

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data === "string") {
        void this.handleControl(socket, event.data).then((isReady) => {
          if (isReady) {
            ready = true;
            this.retryMs = 1000;
          }
        }).catch((error) => {
          this.log(`hello failed: ${error instanceof Error ? error.message : error}`);
          socket.close(1000, "hello failed");
        });
        return;
      }
      if (!ready) return;
      this.handleRelayFrame(new Uint8Array(event.data as ArrayBuffer));
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const session of [...this.sessions.values()]) session.close("relay connection lost", false);
      const reason = event.reason || `closed (${event.code ?? "?"})`;
      // The relay refused this desktop (no admin token, key mismatch): retrying fast won't help.
      if (event.code === 4401) this.retryMs = Math.max(this.retryMs, 60_000);
      this.scheduleReconnect(ready ? "relay connection lost" : reason);
    });
    socket.addEventListener("error", () => { /* the close event follows */ });
  }

  private scheduleReconnect(error: string): void {
    if (this.stopped) return;
    this.setState("error", error);
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 60_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private async handleControl(socket: SocketLike, text: string): Promise<boolean> {
    const message = JSON.parse(text) as { t?: string; nonce?: string; agentId?: string };
    if (message.t === "challenge" && typeof message.nonce === "string") {
      const key = await crypto.subtle.importKey("jwk", this.options.identity.signingPrivate, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      const signature = new Uint8Array(await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`pi-relay-agent/1\n${message.nonce}`),
      ));
      socket.send(JSON.stringify({
        t: "hello",
        key: base64UrlEncode(this.options.identity.signingPublicSpki),
        sig: base64UrlEncode(signature),
        ...(this.config.adminToken ? { admin: this.config.adminToken } : {}),
      }));
      return false;
    }
    if (message.t === "ready") {
      if (message.agentId !== this.agentId) throw new Error("relay named another agent id");
      // Registered: the admin token is no longer needed, so it does not stay on disk.
      if (this.config.adminToken) {
        this.config = { ...this.config, adminToken: undefined };
        delete this.config.adminToken;
        writeRelayConfig(this.options.dir, this.config);
      }
      this.setState("online");
      this.log(`online as ${this.agentId}`);
      return true;
    }
    return false;
  }

  private handleRelayFrame(bytes: Uint8Array): void {
    if (bytes.length < 1 + CLIENT_ID_BYTES) return;
    const kind = bytes[0];
    const clientId = bytes.slice(1, 1 + CLIENT_ID_BYTES);
    const key = Buffer.from(clientId).toString("hex");
    if (kind === KIND_OPEN) {
      this.sessions.get(key)?.close("replaced", false);
      this.sessions.set(key, new PhoneSession(clientId, this));
    } else if (kind === KIND_DATA) {
      this.sessions.get(key)?.receive(bytes.slice(1 + CLIENT_ID_BYTES));
    } else if (kind === KIND_CLOSE) {
      this.sessions.get(key)?.close("phone left", false);
    }
  }

  sendToPhone(clientId: Uint8Array, payload: Uint8Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    const out = new Uint8Array(1 + CLIENT_ID_BYTES + payload.length);
    out[0] = KIND_DATA;
    out.set(clientId, 1);
    out.set(payload, 1 + CLIENT_ID_BYTES);
    socket.send(out);
  }

  forgetSession(session: PhoneSession, reason: string, notifyRelay: boolean): void {
    const key = Buffer.from(session.clientId).toString("hex");
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    if (notifyRelay && this.socket?.readyState === 1) {
      const out = new Uint8Array(1 + CLIENT_ID_BYTES);
      out[0] = KIND_CLOSE;
      out.set(session.clientId, 1);
      this.socket.send(out);
    }
    if (session.pairing) this.options.onChange?.();
    if (session.deviceId) this.log(`phone ${session.deviceId} left: ${reason}`);
    this.options.onChange?.();
  }

  private async staticKeyPair(): Promise<KeyPair> {
    this.staticKey ??= await keyPairFromPrivate(this.options.identity.noisePrivate);
    return this.staticKey;
  }

  private allowHandshake(): boolean {
    const now = Date.now();
    if (now - this.failedHandshakes.start > 60_000) this.failedHandshakes = { start: now, count: 0 };
    return this.failedHandshakes.count < FAILED_HANDSHAKES_PER_MINUTE;
  }

  private recordFailedHandshake(): void {
    this.failedHandshakes.count += 1;
  }

  async handlePhoneMessage(session: PhoneSession, bytes: Uint8Array): Promise<void> {
    if (!session.transport) return this.handshake(session, bytes);
    let plaintext: Uint8Array;
    try {
      plaintext = await session.transport.receive.decrypt(EMPTY, bytes);
    } catch {
      if (session.pairingCandidate) this.recordFailedHandshake();
      return session.close("bad ciphertext");
    }
    if (!session.deviceId) {
      // Pairing: only a phone that holds the secret can produce this message.
      const candidate = session.pairingCandidate;
      if (!candidate || session.pairing) return;
      const frame = decodeFrame(plaintext);
      if (frame.type !== FrameType.PairRequest || candidate.pairing.used || candidate.pairing.expiresAt < Date.now()) {
        return session.close("unexpected pairing message");
      }
      candidate.pairing.used = true;
      let name = "Phone";
      try { name = cleanDeviceName(decodeJson<{ name?: unknown }>(frame.payload).name); } catch { /* keep default */ }
      session.pairingCandidate = null;
      session.pairing = { pairing: candidate.pairing, phoneKey: candidate.phoneKey, name, requestedAt: Date.now() };
      this.log(`pairing request from "${name}"`);
      this.options.onChange?.();
      return;
    }
    const frame = decodeFrame(plaintext);
    this.handleFrame(session, frame.type, frame.stream, frame.payload);
  }

  private async handshake(session: PhoneSession, bytes: Uint8Array): Promise<void> {
    if (!this.allowHandshake()) return session.close("too many failed handshakes");
    const mode = bytes[0];
    const prologue = relayPrologue(this.agentId);
    const s = await this.staticKeyPair();
    try {
      if (mode === MODE_SESSION) {
        const state = await HandshakeState.create({ pattern: "IK", initiator: false, prologue, s });
        await state.readMessage(bytes.subarray(1));
        const phoneKey = state.remoteStatic!;
        const deviceId = deviceIdFor(phoneKey);
        const device = readDevices(this.options.dir).find((d) => d.id === deviceId && d.publicKey === base64UrlEncode(phoneKey));
        if (!device) {
          this.recordFailedHandshake();
          return session.close("unknown device");
        }
        session.transport = await this.finish(state, session);
        session.deviceId = deviceId;
        clearTimeout(session.timer);
        this.touchDevice(deviceId);
        this.log(`phone ${deviceId} (${device.name}) connected`);
        this.options.onChange?.();
        return;
      }
      if (mode === MODE_PAIR) {
        const id = base64UrlEncode(bytes.subarray(1, 1 + PAIRING_ID_BYTES));
        const pairing = this.pairings.get(id);
        if (!pairing || pairing.used || pairing.expiresAt < Date.now()) {
          this.recordFailedHandshake();
          return session.close("no such pairing");
        }
        const state = await HandshakeState.create({ pattern: "IKpsk2", initiator: false, prologue, s, psk: pairing.secret });
        await state.readMessage(bytes.subarray(1 + PAIRING_ID_BYTES));
        session.transport = await this.finish(state, session);
        // Not a request yet: the phone proves the secret with its first transport message.
        // The handshake timer keeps running until then.
        session.pairingCandidate = { pairing, phoneKey: state.remoteStatic! };
        return;
      }
      this.recordFailedHandshake();
      session.close("unknown mode");
    } catch (error) {
      this.recordFailedHandshake();
      session.close(error instanceof NoiseError ? "handshake failed" : `handshake error: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async finish(state: HandshakeState, session: PhoneSession): Promise<Transport> {
    const reply = await state.writeMessage(encodeJson({ v: 1 }));
    this.sendToPhone(session.clientId, reply);
    return state.split();
  }

  private touchDevice(deviceId: string): void {
    const devices = readDevices(this.options.dir);
    const device = devices.find((d) => d.id === deviceId);
    if (!device) return;
    device.lastSeenAt = new Date().toISOString();
    writeDevices(this.options.dir, devices);
  }

  private handleFrame(session: PhoneSession, type: number, streamId: number, payload: Uint8Array): void {
    if (type === FrameType.Ping) {
      void session.send(FrameType.Pong, streamId, payload);
      return;
    }
    if (type === FrameType.Cancel) {
      session.streams.get(streamId)?.controller.abort();
      session.streams.delete(streamId);
      return;
    }
    if (type === FrameType.RequestHead) {
      if (session.streams.has(streamId) || session.streams.size >= MAX_STREAMS) {
        void session.send(FrameType.ResponseError, streamId, encodeJson({ message: "too many requests in flight" }));
        return;
      }
      const head = parseRequestHead(payload);
      if (!head) {
        void session.send(FrameType.ResponseError, streamId, encodeJson({ message: "malformed request" }));
        return;
      }
      session.streams.set(streamId, { head, body: [], size: 0, controller: new AbortController() });
      return;
    }
    const stream = session.streams.get(streamId);
    if (!stream) return;
    if (type === FrameType.RequestBody) {
      stream.size += payload.length;
      if (stream.size > MAX_REQUEST_BODY) {
        session.streams.delete(streamId);
        void session.send(FrameType.ResponseError, streamId, encodeJson({ message: "request body too large" }));
        return;
      }
      stream.body.push(payload.slice());
    } else if (type === FrameType.RequestEnd) {
      void this.replay(session, streamId, stream);
    }
  }

  private async replay(session: PhoneSession, streamId: number, stream: Stream): Promise<void> {
    const head = stream.head!;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const headers = new Headers(sanitizeRequestHeaders(head.headers));
    headers.set(RELAY_MARK_HEADER, relayMarkSecret());
    headers.set(RELAY_DEVICE_HEADER, session.deviceId!);
    const hasBody = head.method !== "GET" && head.method !== "HEAD" && stream.size > 0;
    let body: Uint8Array | undefined;
    if (hasBody) {
      body = new Uint8Array(stream.size);
      let offset = 0;
      for (const chunk of stream.body) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
    }
    try {
      const response = await fetchImpl(`${this.options.localOrigin()}${head.url}`, {
        method: head.method,
        headers,
        body: body as BodyInit | undefined,
        redirect: "manual",
        signal: stream.controller.signal,
      });
      await session.send(FrameType.ResponseHead, streamId, encodeJson({
        status: response.status,
        headers: sanitizeResponseHeaders(response.headers),
      }));
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (let offset = 0; offset < value.length; offset += MAX_FRAME_PAYLOAD) {
              await this.waitForBuffer(stream.controller.signal);
              await session.send(FrameType.ResponseBody, streamId, value.subarray(offset, offset + MAX_FRAME_PAYLOAD));
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      await session.send(FrameType.ResponseEnd, streamId);
    } catch (error) {
      if (!stream.controller.signal.aborted) {
        await session.send(FrameType.ResponseError, streamId, encodeJson({ message: error instanceof Error ? error.message : String(error) }));
      }
    } finally {
      if (session.streams.get(streamId) === stream) session.streams.delete(streamId);
    }
  }

  /** Hold a response while the relay socket has too much queued, so one big download cannot balloon memory. */
  private async waitForBuffer(signal: AbortSignal): Promise<void> {
    while (this.socket && this.socket.bufferedAmount > SEND_BUFFER_LIMIT && !signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (signal.aborted) throw new Error("cancelled");
  }

  // ---- pairing and devices, driven by local-only settings routes ----

  createPairing(): { id: string; url: string; expiresAt: number } {
    const now = Date.now();
    for (const [id, pairing] of this.pairings) if (pairing.expiresAt < now) this.pairings.delete(id);
    const id = base64UrlEncode(randomBytes(PAIRING_ID_BYTES));
    const secret = new Uint8Array(randomBytes(32));
    const expiresAt = now + PAIRING_TTL_MS;
    this.pairings.set(id, { id, secret, expiresAt, used: false });
    const ticket = base64UrlEncode(encodeJson({
      v: 1,
      r: this.config.url,
      a: this.agentId,
      k: base64UrlEncode(this.options.identity.noisePublic),
      i: id,
      s: base64UrlEncode(secret),
    }));
    // The fragment never reaches the entry host or the relay.
    return { id, url: `${this.config.entryUrl}/__shell/#pair=${ticket}`, expiresAt };
  }

  pendingPairings(): PendingPairing[] {
    const out: PendingPairing[] = [];
    for (const session of this.sessions.values()) {
      if (!session.pairing) continue;
      out.push({
        id: session.pairing.pairing.id,
        name: session.pairing.name,
        deviceId: deviceIdFor(session.pairing.phoneKey),
        requestedAt: session.pairing.requestedAt,
      });
    }
    return out;
  }

  private findPairingSession(id: string): PhoneSession | undefined {
    return [...this.sessions.values()].find((session) => session.pairing?.pairing.id === id);
  }

  async approvePairing(id: string): Promise<PairedDevice | null> {
    const session = this.findPairingSession(id);
    if (!session?.pairing || session.pairing.pairing.expiresAt < Date.now()) return null;
    const { phoneKey, name } = session.pairing;
    const device: PairedDevice = {
      id: deviceIdFor(phoneKey),
      name,
      publicKey: base64UrlEncode(phoneKey),
      pairedAt: new Date().toISOString(),
    };
    const devices = readDevices(this.options.dir).filter((d) => d.id !== device.id);
    writeDevices(this.options.dir, [...devices, device]);
    await session.send(FrameType.PairResult, 0, encodeJson({ ok: true, deviceId: device.id }));
    session.pairing = null;
    session.close("paired");
    this.log(`paired "${name}" (${device.id})`);
    return device;
  }

  async denyPairing(id: string): Promise<boolean> {
    const session = this.findPairingSession(id);
    if (!session) return false;
    await session.send(FrameType.PairResult, 0, encodeJson({ ok: false, reason: "denied" }));
    session.pairing = null;
    session.close("pairing denied");
    return true;
  }

  devices(): PairedDevice[] {
    return readDevices(this.options.dir);
  }

  revokeDevice(deviceId: string): boolean {
    const devices = readDevices(this.options.dir);
    const remaining = devices.filter((d) => d.id !== deviceId);
    if (remaining.length === devices.length) return false;
    writeDevices(this.options.dir, remaining);
    for (const session of [...this.sessions.values()]) if (session.deviceId === deviceId) session.close("revoked");
    this.log(`revoked ${deviceId}`);
    return true;
  }

  /** Whether a device is still paired (push subscriptions check this on each send). */
  isDevicePaired(deviceId: string): boolean {
    return readDevices(this.options.dir).some((d) => d.id === deviceId);
  }
}
