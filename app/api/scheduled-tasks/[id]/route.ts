import { NextResponse } from "next/server";
import { errorResponse, rejectUnsafeWrite, toTaskView } from "@/lib/scheduled-tasks/api";
import { emitScheduledTaskEvent } from "@/lib/scheduled-tasks";
import { applyTaskPatch } from "@/lib/scheduled-tasks/task-input";
import { deleteTask, getTask, mutateTasks } from "@/lib/scheduled-tasks/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const task = getTask(id);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    return NextResponse.json({ task: toTaskView(task) });
  } catch (error) {
    return errorResponse(error);
  }
}

// PATCH /api/scheduled-tasks/[id] - edit fields, pause (enabled:false) or resume (enabled:true).
export async function PATCH(req: Request, { params }: Params) {
  const rejected = rejectUnsafeWrite(req);
  if (rejected) return rejected;
  const { id } = await params;
  try {
    const body: unknown = await req.json();
    const now = new Date();
    const updated = mutateTasks((tasks) => {
      const index = tasks.findIndex((task) => task.id === id);
      if (index === -1) return { tasks, result: undefined };
      const others = tasks.filter((_, position) => position !== index).map((task) => task.name);
      const next = [...tasks];
      next[index] = applyTaskPatch(tasks[index], body, { now, otherNames: others });
      return { tasks: next, result: next[index] };
    });
    if (!updated) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    emitScheduledTaskEvent({ type: "task_changed", taskId: id });
    return NextResponse.json({ task: toTaskView(updated, now) });
  } catch (error) {
    return errorResponse(error);
  }
}

// DELETE /api/scheduled-tasks/[id] - remove the task and its run history. The sessions
// it produced stay, as ordinary sessions: with the history gone nothing marks them as
// scheduled runs any more, so they reappear in the project list instead of being left
// hidden with no page that lists them.
export async function DELETE(req: Request, { params }: Params) {
  const rejected = rejectUnsafeWrite(req, { json: false });
  if (rejected) return rejected;
  const { id } = await params;
  try {
    if (!deleteTask(id, { removeRuns: true })) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    emitScheduledTaskEvent({ type: "task_changed", taskId: id });
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}
