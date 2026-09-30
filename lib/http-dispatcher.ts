import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import * as undici from "undici";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

type DispatcherGlobal = typeof globalThis & {
  __piWebHttpDispatcherConfigured?: boolean;
};

type TlsConnectOptions = {
  autoSelectFamily?: boolean;
  ca?: Buffer | string;
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

/** Read NODE_EXTRA_CA_CERTS so undici's custom dispatcher trusts company CAs. */
export function loadExtraCaCerts(
  env: NodeJS.ProcessEnv = process.env,
): Buffer | undefined {
  const certPath = env.NODE_EXTRA_CA_CERTS?.trim();
  if (!certPath) return undefined;
  try {
    return readFileSync(certPath);
  } catch (error) {
    console.warn(`[pi-web] Failed to read NODE_EXTRA_CA_CERTS (${certPath}):`, error);
    return undefined;
  }
}

export function buildTlsConnectOptions(
  env: NodeJS.ProcessEnv = process.env,
): TlsConnectOptions {
  const ca = loadExtraCaCerts(env);
  return {
    // Prefer IPv6 when available, but fall back to IPv4 on ENETUNREACH —
    // common on corp networks that advertise AAAA records they cannot route.
    autoSelectFamily: true,
    ...(ca ? { ca } : {}),
  };
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

export function configureHttpDispatcher(
  timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS,
): void {
  if (dispatcherGlobal.__piWebHttpDispatcherConfigured) return;

  const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === undefined) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
  }

  const tls = buildTlsConnectOptions();
  const dispatcher = withUndiciErrorListener(
    new undici.EnvHttpProxyAgent({
      allowH2: false,
      bodyTimeout: normalizedTimeoutMs,
      headersTimeout: normalizedTimeoutMs,
      // Direct Agent connections (no proxy / NO_PROXY).
      connect: tls,
      // ProxyAgent origin + proxy TLS — EnvHttpProxyAgent forwards these opts.
      requestTls: tls,
      proxyTls: tls,
      clientFactory: createUndiciClient,
      factory: createUndiciOriginDispatcher,
    }),
  );
  undici.setGlobalDispatcher(dispatcher);

  // Keep fetch and the dispatcher on the same undici implementation. Preserve
  // an intentional fetch override installed after this module was loaded.
  if (globalThis.fetch === originalGlobalFetch) {
    undici.install?.();
  }

  dispatcherGlobal.__piWebHttpDispatcherConfigured = true;
}
