/**
 * Who opened an event stream, for the Debug panel's badge titles: the request's reported address
 * and a short browser and system label. A label, never an identity: `x-forwarded-for` is what
 * the client or a proxy says (Next fills it with the socket's address only when the request has
 * none), and a user agent can claim anything. Nothing here decides access. The raw user agent is
 * never kept, only the label read from it.
 */

export interface StreamClient {
  /** The first `x-forwarded-for` entry, IPv4-mapped IPv6 shortened ("::ffff:10.0.0.2" → "10.0.0.2"). */
  address: string | null;
  /** "Chrome · macOS", "Safari · iOS"; null when the user agent names neither. */
  client: string | null;
}

/** Longer than any IPv6 text with a zone; a longer entry is not an address. */
const MAX_ADDRESS_LENGTH = 64;

export function describeStreamClient(headers: Headers): StreamClient {
  return {
    address: streamAddress(headers.get("x-forwarded-for")),
    client: streamClientLabel(headers.get("user-agent")),
  };
}

export function streamAddress(forwardedFor: string | null): string | null {
  const first = forwardedFor?.split(",")[0]?.trim() ?? "";
  if (!first || first.length > MAX_ADDRESS_LENGTH || !/^[0-9A-Za-z.:%[\]_-]+$/.test(first)) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(first);
  return mapped ? mapped[1] : first;
}

// Order matters: Edge and Opera also say Chrome, Chrome also says Safari, iOS browsers say Safari.
const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

// iPhones and iPads before the system says Mac (an iPad asking for desktop sites says Macintosh).
const SYSTEMS: readonly [RegExp, string][] = [
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMacintosh\b|\bMac OS X\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

export function streamClientLabel(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const parts = [browser, system].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}
