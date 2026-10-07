import { NextResponse } from "next/server";
import { errorResponse, rejectUnsafeWrite } from "@/lib/scheduled-tasks/api";
import { nextCronRuns, systemTimezone, validateCron } from "@/lib/scheduled-tasks/cron";

export const dynamic = "force-dynamic";

// POST /api/scheduled-tasks/preview { expr, timezone? } - validate a cron expression
// and list its next five runs, for the editor's live preview. Reads nothing and
// writes nothing, but takes the same guard as the other POSTs.
export async function POST(req: Request) {
  const rejected = rejectUnsafeWrite(req);
  if (rejected) return rejected;
  try {
    const body = await req.json() as { expr?: unknown; timezone?: unknown };
    if (typeof body.expr !== "string" || !body.expr.trim()) {
      return NextResponse.json({ valid: false, error: "expr is required" }, { status: 400 });
    }
    const timezone = typeof body.timezone === "string" && body.timezone ? body.timezone : systemTimezone();
    const now = new Date();
    try {
      validateCron(body.expr, timezone, now);
    } catch (error) {
      return NextResponse.json({ valid: false, error: error instanceof Error ? error.message : String(error) });
    }
    return NextResponse.json({
      valid: true,
      timezone,
      nextRuns: nextCronRuns(body.expr, timezone, 5, now).map((date) => date.toISOString()),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
