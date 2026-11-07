import { EventEmitter } from "node:events";
import * as undici from "undici";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

type DispatcherGlobal = typeof globalThis & {
  __piWebHttpDispatcherConfigured?: boolean;
  __piWebHttpDispatcher?: undici.Dispatcher;
  __piWebHttpDispatcherTimeoutMs?: number;
};

const dispatcherGlobal = globalThis as DispatcherGlobal;
const originalGlobalFetch = globalThis.fetch;
const ignoreUndiciDispatcherError = (): void => {};

function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") return 0;
    if (trimmed.length === 0) return undefined;
    return parseHttpIdleTimeoutMs(Number(trimmed));
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

// Undici can emit an internal Client error while terminating a response body.
// The body stream still rejects; this prevents the EventEmitter error from
// terminating the Next.js process first.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
  return withUndiciErrorListener(
    new undici.Client(origin, options as undici.Client.Options),
  );
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
  const dispatcherOptions = options as undici.Pool.Options;
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(origin, dispatcherOptions);
  }

  return withUndiciErrorListener(
    new undici.Pool(origin, {
      ...dispatcherOptions,
      factory: createUndiciClient,
    }),
  );
}

function createProxyAwareDispatcher(timeoutMs: number): undici.Dispatcher {
  // EnvHttpProxyAgent reads HTTP(S)_PROXY when it is built (NO_PROXY on every
  // request), so a proxy change in Settings rebuilds it; see lib/network-proxy.ts.
  return withUndiciErrorListener(
    new undici.EnvHttpProxyAgent({
      allowH2: false,
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
      clientFactory: createUndiciClient,
      factory: createUndiciOriginDispatcher,
    }),
  );
}

export function configureHttpDispatcher(
  timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS,
): void {
  if (dispatcherGlobal.__piWebHttpDispatcherConfigured) return;

  const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === undefined) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
  }

  const dispatcher = createProxyAwareDispatcher(normalizedTimeoutMs);
  undici.setGlobalDispatcher(dispatcher);
  dispatcherGlobal.__piWebHttpDispatcher = dispatcher;
  dispatcherGlobal.__piWebHttpDispatcherTimeoutMs = normalizedTimeoutMs;

  // Keep fetch and the dispatcher on the same undici implementation. Preserve
  // an intentional fetch override installed after this module was loaded.
  if (globalThis.fetch === originalGlobalFetch) {
    undici.install?.();
  }

  dispatcherGlobal.__piWebHttpDispatcherConfigured = true;
}

/**
 * Rebuild the global dispatcher from the current proxy environment. Requests
 * already in flight (streaming replies included) finish on the old dispatcher,
 * which closes once they are done. A no-op before configureHttpDispatcher().
 */
export function reconfigureHttpDispatcher(): void {
  if (!dispatcherGlobal.__piWebHttpDispatcherConfigured) return;
  const timeoutMs = dispatcherGlobal.__piWebHttpDispatcherTimeoutMs ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  const previous = dispatcherGlobal.__piWebHttpDispatcher;
  const dispatcher = createProxyAwareDispatcher(timeoutMs);
  undici.setGlobalDispatcher(dispatcher);
  dispatcherGlobal.__piWebHttpDispatcher = dispatcher;
  if (previous && previous !== dispatcher) {
    void previous.close().catch(ignoreUndiciDispatcherError);
  }
}
