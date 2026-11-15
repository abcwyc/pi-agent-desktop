import { NextResponse } from "next/server";
import type { CalendarData } from "@/lib/calendar-types";
import { listAllSessions } from "@/lib/session-reader";
import { collectSessionPrompts } from "@/lib/session-prompts";
import { calendarRuns, calendarTask, plannedRuns } from "@/lib/scheduled-tasks/calendar";
import { listRuns, listTasks } from "@/lib/scheduled-tasks/store";

export const dynamic = "force-dynamic";

/** Six weeks of a month grid plus slack; a wider range is refused rather than scanned. */
const MAX_RANGE_MS = 50 * 24 * 60 * 60 * 1000;

// GET /api/calendar?from=<ms>&to=<ms> - for the Tasks page calendar: the prompts each
// session got in the range, scheduled runs that happened in it and the runs still planned.
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const from = Number(params.get("from"));
  const to = Number(params.get("to"));
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from || to - from > MAX_RANGE_MS) {
    return NextResponse.json({ error: "from and to must be a range in ms of at most 50 days" }, { status: 400 });
  }
  try {
    const now = Date.now();
    const sessions = await listAllSessions();
    const prompts = await collectSessionPrompts(sessions, from, to);
    let tasks: ReturnType<typeof listTasks> = [];
    try {
      tasks = listTasks();
    } catch {
      // An unreadable tasks file leaves the calendar with sessions only.
    }
    const data: CalendarData = {
      from,
      to,
      now,
      prompts,
      tasks: tasks.map(calendarTask),
      runs: tasks.flatMap((task) => calendarRuns(listRuns(task.id), from, to)),
      planned: tasks.flatMap((task) => plannedRuns(task, from, to, now)),
    };
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
