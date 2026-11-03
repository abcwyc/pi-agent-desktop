import { NextResponse } from "next/server";
import { isLocalRequest } from "@/lib/remote-access";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRelayConnector } from "@/lib/relay/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/relay/pairing - a one-time pairing link for the QR code (5 minutes, one phone).
// The link carries the pairing secret, so it is only ever handed to this computer.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!isLocalRequest(req)) return NextResponse.json({ error: "Phones are paired on this computer." }, { status: 403 });
  const connector = getRelayConnector();
  if (!connector || connector.status().state !== "online") {
    return NextResponse.json({ error: "Connect to the relay first." }, { status: 409 });
  }
  return NextResponse.json(connector.createPairing(), { headers: { "Cache-Control": "no-store" } });
}
