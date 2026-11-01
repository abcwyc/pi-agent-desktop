import { NextResponse } from "next/server";
import {
  isLocalRequest,
  normalizeRemoteHostname,
  readRemoteAccessConfig,
  writeRemoteAccessConfig,
} from "@/lib/remote-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readTailscaleStatus } from "@/lib/tailscale-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/remote-access - the saved setting, the local Tailscale client's view,
// and whether this request itself came from this computer (only it may change the setting).
export async function GET(req: Request) {
  return NextResponse.json({
    config: readRemoteAccessConfig(),
    tailscale: await readTailscaleStatus(),
    local: isLocalRequest(req),
  }, { headers: { "Cache-Control": "no-store" } });
}

// PUT /api/remote-access  body: { hostname: string | null, logins?: string[] }
// Opening the server to the tailnet is a choice made on this computer, never from a phone.
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "Remote access can only be changed on this computer." }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { hostname?: unknown; logins?: unknown };
    if (body.hostname === null) {
      return NextResponse.json({ config: writeRemoteAccessConfig(null) });
    }
    const hostname = normalizeRemoteHostname(body.hostname);
    if (!hostname) {
      return NextResponse.json({ error: "hostname must be a DNS name such as mac.tail1234.ts.net" }, { status: 400 });
    }
    if (body.logins !== undefined
      && (!Array.isArray(body.logins) || body.logins.some((login) => typeof login !== "string"))) {
      return NextResponse.json({ error: "logins must be a list of strings" }, { status: 400 });
    }
    const logins = (body.logins as string[] | undefined) ?? [];
    return NextResponse.json({ config: writeRemoteAccessConfig({ hostname, logins }) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
