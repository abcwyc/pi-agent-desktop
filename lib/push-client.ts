/**
 * Client-side Web Push subscription. Called once when the Notification
 * permission is granted; silently no-ops on unsupported browsers (e.g. iOS
 * Safari < 16.4 or non-PWA contexts) so the existing in-page notification
 * path keeps working as a fallback.
 */

let activeSubscriptionPromise: Promise<boolean> | null = null;

// Standard base64url → Uint8Array conversion for applicationServerKey.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isPushSupported(): boolean {
  return typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

export async function setupPushSubscription(locale: string): Promise<boolean> {
  if (!isPushSupported() || Notification.permission !== "granted") return false;
  if (activeSubscriptionPromise) return activeSubscriptionPromise;

  const attempt = (async () => {
    try {
      const configResponse = await fetch("/api/push/config");
      if (!configResponse.ok) return false;
      const { publicKey } = await configResponse.json() as { publicKey?: string };
      if (!publicKey) return false;

      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }

      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON(), locale }),
      });
      return response.ok;
    } catch {
      // Retry on the next trigger (e.g. the next permission grant) rather
      // than caching a transient failure forever.
      activeSubscriptionPromise = null;
      return false;
    }
  })();

  activeSubscriptionPromise = attempt;
  void attempt.then((ok) => {
    if (!ok && activeSubscriptionPromise === attempt) activeSubscriptionPromise = null;
  });
  return attempt;
}

export type PushDeviceState = "unsupported" | "denied" | "off" | "on";

/**
 * The page's service worker, or undefined when there is none: it registers only
 * in production builds and never inside the desktop shell, where `ready` would
 * wait forever. A first load may still be registering, so `ready` gets a moment.
 */
async function pushRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000)),
  ]);
}

/** Whether this browser gets pushes from this server, as far as the browser knows. */
export async function getPushDeviceState(): Promise<PushDeviceState> {
  if (!isPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const registration = await pushRegistration();
    if (!registration) return "unsupported";
    if (Notification.permission !== "granted") return "off";
    return (await registration.pushManager.getSubscription()) ? "on" : "off";
  } catch {
    return "off";
  }
}

/**
 * Turn pushes on from a click. iOS grants the permission only inside a user
 * gesture, which is why the automatic path in AppShell never reaches an iPhone.
 */
export async function enablePushOnThisDevice(locale: string): Promise<PushDeviceState> {
  if (!isPushSupported() || !(await pushRegistration())) return "unsupported";
  const permission = Notification.permission === "default"
    ? await Notification.requestPermission()
    : Notification.permission;
  if (permission === "denied") return "denied";
  if (permission !== "granted") return "off";
  return (await setupPushSubscription(locale)) ? "on" : "off";
}

export async function disablePushOnThisDevice(): Promise<PushDeviceState> {
  if (!isPushSupported()) return "unsupported";
  const registration = await pushRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => undefined);
    await subscription.unsubscribe();
  }
  activeSubscriptionPromise = null;
  return "off";
}

/** Ask the server to push a test notification to this device. */
export async function sendTestPushToThisDevice(): Promise<void> {
  const registration = await pushRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) throw new Error("This device is not subscribed");
  const response = await fetch("/api/push/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `HTTP ${response.status}`);
  }
}
