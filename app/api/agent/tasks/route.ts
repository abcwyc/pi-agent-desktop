import { NextResponse } from "next/server";
import { getRpcTaskSnapshots } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/tasks - what each live session is doing, for the Tasks page:
// running and its current step, dialogs waiting for the user, how the last run ended.
export async function GET() {
  return NextResponse.json(
    { tasks: getRpcTaskSnapshots(), now: Date.now() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
