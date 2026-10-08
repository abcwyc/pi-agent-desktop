import { NextResponse } from "next/server";
import { errorResponse, rejectUnsafeWrite, toTaskView } from "@/lib/scheduled-tasks/api";
import { getScheduler, emitScheduledTaskEvent } from "@/lib/scheduled-tasks";
import { buildTask } from "@/lib/scheduled-tasks/task-input";
import { listTasks, mutateTasks } from "@/lib/scheduled-tasks/store";

export const dynamic = "force-dynamic";

// GET /api/scheduled-tasks - every task with its next run, last run and unread count.
export async function GET() {
  try {
    const now = new Date();
    return NextResponse.json({
      tasks: listTasks().map((task) => toTaskView(task, now)),
      scheduler: { owner: getScheduler().isOwner() },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

// POST /api/scheduled-tasks - create a task. Validation is entirely server-side.
export async function POST(req: Request) {
  const rejected = rejectUnsafeWrite(req);
  if (rejected) return rejected;
  try {
    const body: unknown = await req.json();
    const now = new Date();
    const task = mutateTasks((tasks) => {
      const created = buildTask(body, { now, otherNames: tasks.map((existing) => existing.name) });
      return { tasks: [...tasks, created], result: created };
    });
    emitScheduledTaskEvent({ type: "task_changed", taskId: task.id });
    return NextResponse.json({ task: toTaskView(task, now) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
