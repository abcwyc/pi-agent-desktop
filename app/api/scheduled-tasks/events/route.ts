import { getScheduler, subscribeScheduledTaskEvents } from "@/lib/scheduled-tasks";

export const dynamic = "force-dynamic";

// GET /api/scheduled-tasks/events - SSE stream of run and task changes, so the
// Scheduled view and the sidebar badge never poll.
export async function GET(req: Request) {
  let dispose = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe = () => {};
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        req.signal?.removeEventListener("abort", cleanup);
        try { controller.close(); } catch { /* already closed */ }
      };
      dispose = cleanup;
      req.signal?.addEventListener("abort", cleanup);
      const send = (data: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { cleanup(); }
      };
      unsubscribe = subscribeScheduledTaskEvents(send);
      send({ type: "scheduler_owner", owner: getScheduler().isOwner() });
      heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(":\n\n")); } catch { cleanup(); }
      }, 30_000);
    },
    cancel() { dispose(); },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
