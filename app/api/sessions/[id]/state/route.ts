import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { getComposerQueueVersion, getPendingComposerMessages } from "@/lib/composer-queue";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      const state = await rpc.send({ type: "get_state" });
      return NextResponse.json({ running: true, state });
    }

    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const pending = getPendingComposerMessages(id);
    return NextResponse.json({ running: false, ...(pending.length ? { state: { queuedMessages: { pending, pendingVersion: getComposerQueueVersion(id) } } } : {}) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
