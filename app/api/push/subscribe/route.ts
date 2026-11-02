import { tailscaleLoginOf } from "@/lib/remote-access";
import { addSubscription, type PushSubscriptionRecord } from "@/lib/web-push";

export const dynamic = "force-dynamic";

interface SubscribeRequestBody {
  subscription?: Partial<PushSubscriptionRecord>;
  locale?: string;
}

function isValidSubscription(subscription: Partial<PushSubscriptionRecord> | undefined): subscription is PushSubscriptionRecord {
  if (typeof subscription !== "object" || subscription === null) return false;
  if (typeof subscription.endpoint !== "string" || !/^https:\/\//.test(subscription.endpoint)) return false;
  const keys = subscription.keys;
  if (typeof keys !== "object" || keys === null) return false;
  return typeof keys.p256dh === "string" && keys.p256dh.length > 0
    && typeof keys.auth === "string" && keys.auth.length > 0;
}

// POST /api/push/subscribe - register a browser push subscription. Upserts by
// endpoint, so the client can safely re-send its subscription on every load.
export async function POST(req: Request): Promise<Response> {
  let body: SubscribeRequestBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isValidSubscription(body.subscription)) {
    return Response.json({ error: "Invalid push subscription" }, { status: 400 });
  }

  const locale = body.locale === "zh-CN" || body.locale === "zh-TW" ? body.locale : "en";
  // A phone subscribing through Tailscale is tied to its login, so removing the login
  // (or turning remote access off) also stops its notifications.
  const login = tailscaleLoginOf(req);
  await addSubscription({
    endpoint: body.subscription.endpoint,
    keys: body.subscription.keys,
    locale,
    ...(login ? { login } : {}),
  });
  return Response.json({ ok: true });
}
