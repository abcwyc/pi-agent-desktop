/**
 * One server-sent event stream for every tab of a browser.
 *
 * A browser allows only about six open connections to one host over HTTP/1.1, and a
 * tab here already holds several long-lived ones (running sessions, the open session,
 * file watchers). One more per tab would leave a few tabs unable to load anything. So
 * the tabs elect a leader through the Web Locks API: only it opens the stream, and it
 * passes each event on to the others over a BroadcastChannel. When the leader goes
 * away its lock is released and the next tab in line takes over.
 *
 * Without Web Locks or BroadcastChannel every tab opens its own stream.
 */

interface SourceLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  readonly readyState: number;
  close(): void;
}

interface ChannelLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

interface LockManagerLike {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<unknown>;
}

export interface SharedStreamEnv {
  locks?: LockManagerLike;
  createChannel?: (name: string) => ChannelLike;
  createSource: (url: string) => SourceLike;
  /** EventSource.CLOSED */
  closedState?: number;
  retryMs?: number;
}

export interface SharedStreamOptions<T> {
  url: string;
  /** Names both the lock and the channel. */
  name: string;
  onEvent: (event: T) => void;
  /** The stream (re)connected, so anything missed meanwhile should be reloaded. Leader only. */
  onOpen?: () => void;
  env?: SharedStreamEnv;
}

function browserEnv(): SharedStreamEnv | null {
  if (typeof EventSource === "undefined") return null;
  return {
    locks: typeof navigator !== "undefined" ? (navigator as { locks?: LockManagerLike }).locks : undefined,
    createChannel: typeof BroadcastChannel !== "undefined"
      ? (name) => new BroadcastChannel(name) as unknown as ChannelLike
      : undefined,
    createSource: (url) => new EventSource(url) as unknown as SourceLike,
    closedState: EventSource.CLOSED,
  };
}

/** Start receiving events; the returned function stops, and releases leadership if held. */
export function openSharedEventStream<T>(options: SharedStreamOptions<T>): () => void {
  const env = options.env ?? browserEnv();
  if (!env) return () => undefined;
  const retryMs = env.retryMs ?? 3000;

  let closed = false;
  let source: SourceLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let channel: ChannelLike | null = null;

  const openSource = () => {
    if (closed) return;
    const stream = env.createSource(options.url);
    source = stream;
    stream.onopen = () => { options.onOpen?.(); };
    stream.onmessage = (message) => {
      let event: T;
      try { event = JSON.parse(message.data) as T; } catch { return; /* a malformed frame */ }
      options.onEvent(event);
      channel?.postMessage(event);
    };
    stream.onerror = () => {
      // EventSource retries by itself unless the browser gave up on it for good.
      if (stream.readyState !== (env.closedState ?? 2) || closed) return;
      stream.close();
      source = null;
      retryTimer ??= setTimeout(() => { retryTimer = null; openSource(); }, retryMs);
    };
  };

  const closeSource = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    source?.close();
    source = null;
  };

  if (!env.locks || !env.createChannel) {
    openSource();
    return () => { closed = true; closeSource(); };
  }

  channel = env.createChannel(options.name);
  channel.onmessage = (message) => {
    if (!closed) options.onEvent(message.data as T);
  };
  const abort = new AbortController();
  let releaseLeadership: (() => void) | null = null;

  // Queued behind whichever tab leads now; granted when that tab closes or stops.
  env.locks
    .request(options.name, { signal: abort.signal }, () => new Promise<void>((resolve) => {
      if (closed) { resolve(); return; }
      releaseLeadership = resolve;
      openSource();
    }))
    .catch(() => undefined); // an AbortError when we stopped while still waiting

  return () => {
    closed = true;
    abort.abort();
    closeSource();
    releaseLeadership?.();
    channel?.close();
    channel = null;
  };
}
