import { NextResponse } from "next/server";
import { isLocalRequest } from "@/lib/remote-access";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRelayConnector, relayFilesDir } from "@/lib/relay/runtime";
import { readDevices, writeDevices } from "@/lib/relay/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// DELETE /api/relay/devices/[id] - forget a paired phone and close its sessions.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!isLocalRequest(req)) return NextResponse.json({ error: "Phones are removed on this computer." }, { status: 403 });
  const connector = getRelayConnector();
  if (connector) {
    return connector.revokeDevice(id) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "No such phone." }, { status: 404 });
  }
  // The relay is off: still forget the key, so the phone stays out when it comes back on.
  const devices = readDevices(relayFilesDir());
  const remaining = devices.filter((device) => device.id !== id);
  if (remaining.length === devices.length) return NextResponse.json({ error: "No such phone." }, { status: 404 });
  writeDevices(relayFilesDir(), remaining);
  return NextResponse.json({ ok: true });
}
