import * as undici from "undici";

/** Any HTTP answer through the proxy proves it works; this one is small and widely reachable. */
export const PROXY_TEST_TARGET = "https://www.google.com/generate_204";
export const PROXY_TEST_TIMEOUT_MS = 10_000;

export type ProxyTestFailure =
  | "refused"
  | "notFound"
  | "auth"
  | "rejected"
  | "timeout"
  | "unreachable";

export type ProxyTestResult =
  | { ok: true; status: number; elapsedMs: number; target: string }
  | { ok: false; reason: ProxyTestFailure; message: string; elapsedMs: number; target: string };

function errorChain(error: unknown): { codes: string[]; messages: string[] } {
  const codes: string[] = [];
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current === "object") {
      const record = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
      if (typeof record.code === "string") codes.push(record.code);
      if (typeof record.name === "string") codes.push(record.name);
      if (typeof record.message === "string") messages.push(record.message);
      current = record.cause;
    } else {
      messages.push(String(current));
      break;
    }
  }
  return { codes, messages };
}

export function classifyProxyTestError(error: unknown): { reason: ProxyTestFailure; message: string } {
  const { codes, messages } = errorChain(error);
  const message = messages.find(Boolean) ?? "Unknown error";
  const text = messages.join(" ");
  if (codes.includes("ECONNREFUSED")) return { reason: "refused", message };
  if (codes.includes("ENOTFOUND") || codes.includes("EAI_AGAIN")) return { reason: "notFound", message };
  if (/\(407\)/.test(text)) return { reason: "auth", message };
  if (/Proxy response \(\d+\)/.test(text)) return { reason: "rejected", message };
  if (
    codes.includes("TimeoutError")
    || codes.includes("AbortError")
    || codes.includes("UND_ERR_CONNECT_TIMEOUT")
    || codes.includes("UND_ERR_HEADERS_TIMEOUT")
    || codes.includes("ETIMEDOUT")
  ) {
    return { reason: "timeout", message };
  }
  return { reason: "unreachable", message };
}

/** Send one request through `proxyUrl` (not the saved setting) and report how it went. */
export async function testNetworkProxy(
  proxyUrl: string,
  options: { target?: string; timeoutMs?: number } = {},
): Promise<ProxyTestResult> {
  const target = options.target ?? PROXY_TEST_TARGET;
  const timeoutMs = options.timeoutMs ?? PROXY_TEST_TIMEOUT_MS;
  const started = Date.now();
  const agent = new undici.ProxyAgent({
    uri: proxyUrl,
    connectTimeout: timeoutMs,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  try {
    const response = await undici.fetch(target, {
      method: "GET",
      redirect: "manual",
      dispatcher: agent,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    return { ok: true, status: response.status, elapsedMs: Date.now() - started, target };
  } catch (error) {
    return { ok: false, ...classifyProxyTestError(error), elapsedMs: Date.now() - started, target };
  } finally {
    void agent.close().catch(() => undefined);
  }
}
