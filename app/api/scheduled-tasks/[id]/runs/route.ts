import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/scheduled-tasks/api";
import { getTask, listRuns } from "@/lib/scheduled-tasks/store";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// GET /api/scheduled-tasks/[id]/runs?limit=50&before=<runId> - newest first.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    if (!getTask(id)) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    const url = new URL(req.url);
    const requested = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;
    const before = url.searchParams.get("before");
    const newestFirst = listRuns(id).reverse();
    const start = before ? newestFirst.findIndex((run) => run.runId === before) + 1 : 0;
    const page = newestFirst.slice(start, start + limit);
    return NextResponse.json({ runs: page, hasMore: start + limit < newestFirst.length });
  } catch (error) {
    return errorResponse(error);
  }
}
