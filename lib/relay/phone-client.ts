import {
  FrameType,
  chunkBody,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJson,
  parseResponseHead,
  verificationCode,
  type RequestHead,
  type ResponseHead,
} from "./frames.ts";
import { HandshakeState, base64UrlDecode, type KeyPair, type Transport } from "./noise.ts";

/**
 * The phone end of the relay (docs/remote-relay.md): pairing with a QR ticket,
 * then encrypted sessions that carry the app's HTTP requests. Runs in the
 * phone shell (bundled by scripts/build-relay-shell.mjs) and in Node tests.
 * Mirrors lib/relay/connector.ts.
 */

export const MODE_SESSION = 1;
export const MODE_PAIR = 2;
const PING_INTERVAL_MS = 25_000;
const EMPTY = new Uint8Array(0);

export interface PairingTicket {
  relayUrl: string;
  agentId: string;
  desktopKey: Uint8Array;
  pairingId: Uint8Array;
  secret: Uint8Array;
}

/** What a paired phone keeps (in IndexedDB, with a non-extractable device key). */
export interface PhoneConfig {
  relayUrl: string;
  agentId: string;
  desktopKey: Uint8Array;
  device: KeyPair;
  deviceId?: string;
}

type SocketLike = {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void;
};
export type SocketFactory = (url: string) => SocketLike;

export class RelayClosedError extends Error {
  code: number;
  constructor(code: number, reason: string) {
    super(reason || `relay connection closed (${code})`);
    this.code = code;
  }
}

/** Parse `#pair=<ticket>` from the QR link; null when it is not a valid ticket. */
export function parsePairingTicket(fragment: string): PairingTicket | null {
  const match = /(?:^#?|&)pair=([A-Za-z0-9_-]+)/.exec(fragment);
  if (!match) return null;
  try {
    const value = decodeJson<{ v?: number; r?: string; a?: string; k?: string; i?: string; s?: string }>(base64UrlDecode(match[1]));
    if (value.v !== 1 || typeof value.r !== "string" || !/^wss?:\/\//.test(value.r)) return null;
    if (typeof value.a !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(value.a)) return null;
    const desktopKey = base64UrlDecode(value.k ?? "");
    const pairingId = base64UrlDecode(value.i ?? "");
    const secret = base64UrlDecode(value.s ?? "");
    if (desktopKey.length !== 32 || pairingId.length !== 8 || secret.length !== 32) return null;
    return { relayUrl: value.r, agentId: value.a, desktopKey, pairingId, secret };
  } catch {
    return null;
  }
}

export function relayPrologue(agentId: string): Uint8Array {
  return new TextEncoder().encode(`pi-relay/1\n${agentId}`);
}

function concat(a: Uint8Array, b: Uint8Array, c: Uint8Array = EMPTY): Uint8Array {
  const out = new Uint8Array(a.length + b.length + c.length);
  out.set(a, 0);
  out.set(b, a.length);
  out.set(c, a.length + b.length);
  return out;
}

function defaultSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

/**
 * A connected socket that hands out its messages one at a time. Handshake
 * replies and transport frames arrive on the same socket; queueing them keeps
 * none from being lost while the previous one is still being decrypted.
 */
class Channel {
  private readonly queue: Uint8Array[] = [];
  private waiters: ((bytes: Uint8Array) => void)[] = [];
  private closeWaiters: ((error: Error) => void)[] = [];
  closedWith: RelayClosedError | null = null;
  onMessage: ((bytes: Uint8Array) => void) | null = null;
  onClose: ((error: RelayClosedError) => void) | null = null;
  readonly socket: SocketLike;

  private constructor(socket: SocketLike) {
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      if (this.onMessage) return this.onMessage(bytes);
      const waiter = this.waiters.shift();
      if (waiter) waiter(bytes);
      else this.queue.push(bytes);
    });
    socket.addEventListener("close", (event) => {
      this.closedWith = new RelayClosedError(event.code ?? 1006, event.reason ?? "");
      for (const waiter of this.closeWaiters) waiter(this.closedWith);
      this.closeWaiters = [];
      this.waiters = [];
      this.onClose?.(this.closedWith);
    });
  }

  static open(url: string, factory: SocketFactory): Promise<Channel> {
    return new Promise((resolve, reject) => {
      const socket = factory(url);
      const channel = new Channel(socket);
      socket.addEventListener("open", () => resolve(channel));
      socket.addEventListener("close", (event) => reject(new RelayClosedError(event.code ?? 1006, event.reason ?? "")));
    });
  }

  next(): Promise<Uint8Array> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closedWith) return Promise.reject(this.closedWith);
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
      this.closeWaiters.push(reject);
    });
  }

  send(bytes: Uint8Array): void {
    if (this.socket.readyState === 1) this.socket.send(bytes);
  }

  /** Switch from pulling messages to a handler, first handing it anything already queued. */
  listen(handler: (bytes: Uint8Array) => void): void {
    this.onMessage = handler;
    for (const bytes of this.queue.splice(0)) handler(bytes);
  }
}

async function handshake(
  channel: Channel,
  options: { pattern: "IK" | "IKpsk2"; agentId: string; desktopKey: Uint8Array; device: KeyPair; psk?: Uint8Array; prefix: Uint8Array; payload: unknown },
): Promise<Transport> {
  const state = await HandshakeState.create({
    pattern: options.pattern,
    initiator: true,
    prologue: relayPrologue(options.agentId),
    s: options.device,
    rs: options.desktopKey,
    psk: options.psk,
  });
  channel.send(concat(options.prefix, await state.writeMessage(encodeJson(options.payload))));
  await state.readMessage(await channel.next());
  return state.split();
}

/**
 * Pair with the desktop named in a QR ticket. Resolves once the user approves
 * on the desktop; rejects when denied, expired, or the secret is wrong.
 */
export async function pairPhone(options: {
  ticket: PairingTicket;
  device: KeyPair;
  name: string;
  socket?: SocketFactory;
  /** With the code the desktop shows next to this request; the user compares them. */
  onWaitingForApproval?: (code: string) => void;
}): Promise<{ deviceId: string }> {
  const { ticket } = options;
  const channel = await Channel.open(`${ticket.relayUrl}/client?agent=${encodeURIComponent(ticket.agentId)}`, options.socket ?? defaultSocket);
  try {
    const transport = await handshake(channel, {
      pattern: "IKpsk2",
      agentId: ticket.agentId,
      desktopKey: ticket.desktopKey,
      device: options.device,
      psk: ticket.secret,
      prefix: concat(Uint8Array.of(MODE_PAIR), ticket.pairingId),
      payload: { v: 1 },
    });
    // Encrypted with keys that depend on the secret: the desktop's proof that we hold it.
    channel.send(await transport.send.encrypt(EMPTY, encodeFrame(FrameType.PairRequest, 0, encodeJson({ name: options.name }))));
    options.onWaitingForApproval?.(verificationCode(transport.handshakeHash));
    const frame = decodeFrame(await transport.receive.decrypt(EMPTY, await channel.next()));
    if (frame.type !== FrameType.PairResult) throw new Error("unexpected reply while pairing");
    const result = decodeJson<{ ok?: boolean; deviceId?: string; reason?: string }>(frame.payload);
    if (!result.ok || typeof result.deviceId !== "string") throw new Error(result.reason === "denied" ? "Pairing was denied on the computer." : "Pairing failed.");
    return { deviceId: result.deviceId };
  } finally {
    channel.socket.close(1000, "done");
  }
}

interface PendingResponse {
  resolve: (value: { head: ResponseHead; body: ReadableStream<Uint8Array> }) => void;
  reject: (error: Error) => void;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  headReceived: boolean;
}

export type TunnelState = "connecting" | "open" | "closed";

/** An encrypted session to the desktop that carries HTTP requests. */
export class PhoneTunnel {
  private channel: Channel | null = null;
  private transport: Transport | null = null;
  private nextStream = 1;
  private readonly pending = new Map<number, PendingResponse>();
  private sendChain: Promise<void> = Promise.resolve();
  private receiveChain: Promise<void> = Promise.resolve();
  private ping: ReturnType<typeof setInterval> | null = null;
  state: TunnelState = "connecting";
  onClose: ((error: RelayClosedError) => void) | null = null;
  private readonly config: PhoneConfig;
  private readonly socketFactory: SocketFactory;

  constructor(config: PhoneConfig, socketFactory: SocketFactory = defaultSocket) {
    this.config = config;
    this.socketFactory = socketFactory;
  }

  async connect(): Promise<void> {
    const channel = await Channel.open(
      `${this.config.relayUrl}/client?agent=${encodeURIComponent(this.config.agentId)}`,
      this.socketFactory,
    );
    this.channel = channel;
    channel.onClose = (error) => this.fail(error);
    this.transport = await handshake(channel, {
      pattern: "IK",
      agentId: this.config.agentId,
      desktopKey: this.config.desktopKey,
      device: this.config.device,
      prefix: Uint8Array.of(MODE_SESSION),
      payload: { v: 1 },
    });
    channel.listen((bytes) => {
      this.receiveChain = this.receiveChain.then(() => this.receive(bytes)).catch((error) => {
        this.close();
        this.fail(new RelayClosedError(4500, error instanceof Error ? error.message : String(error)));
      });
    });
    this.state = "open";
    // The first frame proves this session to the desktop (a replayed handshake cannot send one).
    void this.sendFrame(FrameType.Ping, 0);
    this.ping = setInterval(() => { void this.sendFrame(FrameType.Ping, 0); }, PING_INTERVAL_MS);
  }

  private fail(error: RelayClosedError): void {
    if (this.state === "closed") return;
    this.state = "closed";
    if (this.ping) clearInterval(this.ping);
    for (const pending of this.pending.values()) {
      if (pending.headReceived) {
        try { pending.controller?.error(error); } catch { /* already closed */ }
      } else {
        pending.reject(error);
      }
    }
    this.pending.clear();
    this.onClose?.(error);
  }

  close(): void {
    this.channel?.socket.close(1000, "closed");
  }

  private sendFrame(type: (typeof FrameType)[keyof typeof FrameType], stream: number, payload: Uint8Array = EMPTY): Promise<void> {
    const next = this.sendChain.then(async () => {
      if (!this.transport || !this.channel) throw new Error("tunnel not open");
      this.channel.send(await this.transport.send.encrypt(EMPTY, encodeFrame(type, stream, payload)));
    });
    this.sendChain = next.catch(() => {});
    return next;
  }

  private async receive(bytes: Uint8Array): Promise<void> {
    const frame = decodeFrame(await this.transport!.receive.decrypt(EMPTY, bytes));
    const pending = this.pending.get(frame.stream);
    if (!pending) return;
    if (frame.type === FrameType.ResponseHead) {
      const head = parseResponseHead(frame.payload);
      if (!head) throw new Error("malformed response head");
      pending.headReceived = true;
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => { pending.controller = controller; },
        cancel: () => {
          this.pending.delete(frame.stream);
          void this.sendFrame(FrameType.Cancel, frame.stream);
        },
      });
      pending.resolve({ head, body });
    } else if (frame.type === FrameType.ResponseBody) {
      try { pending.controller?.enqueue(frame.payload.slice()); } catch { /* reader gone */ }
    } else if (frame.type === FrameType.ResponseEnd) {
      this.pending.delete(frame.stream);
      try { pending.controller?.close(); } catch { /* already closed */ }
    } else if (frame.type === FrameType.ResponseError) {
      this.pending.delete(frame.stream);
      const message = (() => { try { return decodeJson<{ message?: string }>(frame.payload).message ?? "request failed"; } catch { return "request failed"; } })();
      if (pending.headReceived) {
        try { pending.controller?.error(new Error(message)); } catch { /* closed */ }
      } else {
        pending.reject(new Error(message));
      }
    }
  }

  /** Send one HTTP request through the tunnel; the body streams as it arrives. */
  request(head: RequestHead, body?: Uint8Array, signal?: AbortSignal): Promise<{ head: ResponseHead; body: ReadableStream<Uint8Array> }> {
    if (this.state !== "open") return Promise.reject(new Error("tunnel not open"));
    const stream = this.nextStream;
    this.nextStream += 2;
    const result = new Promise<{ head: ResponseHead; body: ReadableStream<Uint8Array> }>((resolve, reject) => {
      this.pending.set(stream, { resolve, reject, controller: null, headReceived: false });
    });
    signal?.addEventListener("abort", () => {
      const pending = this.pending.get(stream);
      if (!pending) return;
      this.pending.delete(stream);
      void this.sendFrame(FrameType.Cancel, stream);
      const error = new DOMException("aborted", "AbortError");
      if (pending.headReceived) {
        try { pending.controller?.error(error); } catch { /* closed */ }
      } else {
        pending.reject(error);
      }
    }, { once: true });
    void (async () => {
      await this.sendFrame(FrameType.RequestHead, stream, encodeJson(head));
      if (body) for (const chunk of chunkBody(body)) await this.sendFrame(FrameType.RequestBody, stream, chunk);
      await this.sendFrame(FrameType.RequestEnd, stream);
    })().catch((error) => {
      const pending = this.pending.get(stream);
      this.pending.delete(stream);
      pending?.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return result;
  }
}
