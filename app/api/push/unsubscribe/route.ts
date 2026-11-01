import { removeSubscription } from "@/lib/web-push";
import { readEndpoint } from "@/lib/push-endpoint-body";

export const dynamic = "force-dynamic";

// POST /api/push/unsubscribe  body: { endpoint } - stop pushing to this device.
export async function POST(req: Request): Promise<Response> {
  const endpoint = await readEndpoint(req);
  if (!endpoint) return Response.json({ error: "Invalid push endpoint" }, { status: 400 });
  return Response.json({ ok: true, removed: await removeSubscription(endpoint) });
}
