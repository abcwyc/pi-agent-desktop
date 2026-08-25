import { NextResponse } from "next/server";
import { buildSessionContext, resolveSessionPath } from "@/lib/session-reader";
import { openSessionManagerForRead } from "@/lib/session-manager-access";
import { formatSessionReference } from "@/lib/session-reference";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });

    const sm = openSessionManagerForRead(id, filePath);
    if (!sm) return NextResponse.json({ error: "Session not found" }, { status: 404 });

    const context = buildSessionContext(sm.getEntries() as never, sm.getLeafId(), {
      deferThinking: false,
      deferToolResultImages: true,
    });
    return NextResponse.json({
      reference: formatSessionReference(id, sm.getSessionName(), context.messages),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

