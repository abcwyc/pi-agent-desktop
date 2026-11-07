import { NextResponse } from "next/server";
import {
  applyNetworkProxySettings,
  parseNetworkProxyUpdate,
  readEffectiveNetworkProxy,
  readNetworkProxySettings,
  redactProxyUrl,
  writeNetworkProxySettings,
  type EffectiveNetworkProxy,
  type NetworkProxySettings,
} from "@/lib/network-proxy";
import { isLocalRequest } from "@/lib/remote-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function forRequest(local: boolean, settings: NetworkProxySettings, effective: EffectiveNetworkProxy) {
  // A proxy password only goes back to this computer, never to a paired phone or tailnet device.
  if (local) return { settings, effective, local };
  return {
    settings: { ...settings, url: redactProxyUrl(settings.url) },
    effective: { ...effective, url: effective.url && redactProxyUrl(effective.url) },
    local,
  };
}

// GET /api/network-proxy - the saved setting, the proxy in effect and where it comes from.
export async function GET(req: Request) {
  return NextResponse.json(
    forRequest(isLocalRequest(req), readNetworkProxySettings(), readEffectiveNetworkProxy()),
    { headers: { "Cache-Control": "no-store" } },
  );
}

// PUT /api/network-proxy  body: { enabled, url, noProxy? }
// Routing all of this computer's model traffic is decided on this computer only.
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "The network proxy can only be changed on this computer." }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const parsed = parseNetworkProxyUpdate(await req.json());
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const settings = writeNetworkProxySettings(parsed.settings);
    const effective = applyNetworkProxySettings(settings);
    return NextResponse.json(forRequest(true, settings, effective));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
