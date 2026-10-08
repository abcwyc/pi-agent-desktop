import { NextResponse } from "next/server";
import { emitScheduledTaskEvent } from "@/lib/scheduled-tasks";
import { errorResponse, rejectUnsafeWrite } from "@/lib/scheduled-tasks/api";
import { updateRun } from "@/lib/scheduled-tasks/store";

export const dynamic = "force-dynamic";

// POST /api/scheduled-tasks/[id]/runs/[runId]/seen - the user opened this run.
export async function POST(req: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const rejected = rejectUnsafeWrite(req, { json: false });
  if (rejected) return rejected;
  const { id, runId } = await params;
  try {
    const seenAt = new Date().toISOString();
    const run = updateRun(id, runId, (stored) => (stored.seenAt ? stored : { ...stored, seenAt }));
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
    emitScheduledTaskEvent({ type: "task_changed", taskId: id });
    return NextResponse.json({ run });
  } catch (error) {
    return errorResponse(error);
  }
}
