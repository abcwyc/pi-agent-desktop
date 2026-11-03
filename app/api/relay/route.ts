import { NextResponse } from "next/server";
import { isLocalRequest } from "@/lib/remote-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getRelayConnector, relayFilesDir, restartRelayFromConfig } from "@/lib/relay/runtime";
import { normalizeEntryUrl, normalizeRelayUrl, readDevices, readRelayConfig, writeRelayConfig } from "@/lib/relay/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function snapshot(local: boolean) {
  const dir = relayFilesDir();
  const config = readRelayConfig(dir);
  const connector = getRelayConnector();
  return {
    local,
    config: config && { enabled: config.enabled, url: config.url, entryUrl: config.entryUrl, needsRegistration: Boolean(config.adminToken) },
    status: connector?.status() ?? { state: "off", agentId: "", phones: 0 },
    devices: readDevices(dir),
    pending: connector?.pendingPairings() ?? [],
  };
}

// GET /api/relay - Settings › Remote relay: configuration (never the admin token),
// connection state, paired phones, and pairing requests waiting for approval.
export async function GET(req: Request) {
  return NextResponse.json(snapshot(isLocalRequest(req)), { headers: { "Cache-Control": "no-store" } });
}

// PUT /api/relay  body: { url, entryUrl, enabled, adminToken? }
// Who can reach this computer is decided on this computer, never from a phone.
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!isLocalRequest(req)) return NextResponse.json({ error: "The relay can only be changed on this computer." }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await req.json() as { url?: unknown; entryUrl?: unknown; enabled?: unknown; adminToken?: unknown };
    const url = normalizeRelayUrl(body.url);
    const entryUrl = normalizeEntryUrl(body.entryUrl);
    if (!url) return NextResponse.json({ error: "Relay URL must be wss://… (ws:// only on this computer)" }, { status: 400 });
    if (!entryUrl) return NextResponse.json({ error: "Entry URL must be an https:// origin with no path" }, { status: 400 });
    if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    const previous = readRelayConfig(relayFilesDir());
    const adminToken = typeof body.adminToken === "string" && body.adminToken.trim()
      ? body.adminToken.trim()
      : previous?.url === url ? previous.adminToken : undefined;
    writeRelayConfig(relayFilesDir(), { enabled: body.enabled, url, entryUrl, ...(adminToken ? { adminToken } : {}) });
    await restartRelayFromConfig();
    return NextResponse.json(snapshot(true));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
