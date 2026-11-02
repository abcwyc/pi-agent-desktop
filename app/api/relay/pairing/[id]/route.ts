import { NextResponse } from "next/server";
import { isLocalRequest } from "@/lib/remote-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getRelayConnector } from "@/lib/relay/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/relay/pairing/[id]  body: { action: "approve" | "deny" }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!isLocalRequest(req)) return NextResponse.json({ error: "Phones are approved on this computer." }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const body = await req.json().catch(() => ({})) as { action?: unknown };
  const connector = getRelayConnector();
  if (!connector) return NextResponse.json({ error: "The relay is off." }, { status: 409 });
  if (body.action === "approve") {
    const device = await connector.approvePairing(id);
    return device ? NextResponse.json({ device }) : NextResponse.json({ error: "That pairing request is gone or expired." }, { status: 404 });
  }
  if (body.action === "deny") {
    return (await connector.denyPairing(id)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "That pairing request is gone." }, { status: 404 });
  }
  return NextResponse.json({ error: "action must be approve or deny" }, { status: 400 });
}
