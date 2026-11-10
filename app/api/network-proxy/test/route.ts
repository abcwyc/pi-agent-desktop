import { NextResponse } from "next/server";
import { normalizeProxyUrl } from "@/lib/network-proxy";
import { testNetworkProxy } from "@/lib/network-proxy-test";
import { isLocalRequest } from "@/lib/remote-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/network-proxy/test  body: { url }
// Connects to an arbitrary host:port, so like the setting itself it is local-only.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "The network proxy can only be tested on this computer." }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const raw = (body as { url?: unknown } | null)?.url;
  if (typeof raw !== "string") return NextResponse.json({ error: "url must be a string" }, { status: 400 });
  const normalized = normalizeProxyUrl(raw);
  if (!normalized.ok) return NextResponse.json({ error: normalized.error }, { status: 400 });
  return NextResponse.json(await testNetworkProxy(normalized.url), { headers: { "Cache-Control": "no-store" } });
}
