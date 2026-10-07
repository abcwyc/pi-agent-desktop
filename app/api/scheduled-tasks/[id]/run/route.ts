import { NextResponse } from "next/server";
import { errorResponse, rejectUnsafeWrite } from "@/lib/scheduled-tasks/api";
import { getScheduler, isRunRejectedError } from "@/lib/scheduled-tasks";

export const dynamic = "force-dynamic";

// POST /api/scheduled-tasks/[id]/run - start the task now. Answers once the run's
// session exists; the run itself continues in the background.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = rejectUnsafeWrite(req, { json: false });
  if (rejected) return rejected;
  const { id } = await params;
  try {
    const { run } = await getScheduler().runNow(id);
    return NextResponse.json({ run }, { status: 202 });
  } catch (error) {
    if (isRunRejectedError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.code === "not_found" ? 404 : 409 },
      );
    }
    return errorResponse(error);
  }
}
