import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import webpush from "web-push";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { enLocale } from "./i18n/messages/en";
import { zhCNLocale } from "./i18n/messages/zh-CN";
import { getAgentDir } from "./session-reader";
import { isTailscaleLoginAllowed } from "./remote-access";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  locale: string;
  /** The Tailscale login that subscribed through Settings › Remote access; absent for this computer's own browser. */
  login?: string;
}

interface PushStateFile {
  vapidKeys: { publicKey: string; privateKey: string };
  subscriptions: PushSubscriptionRecord[];
}

interface WebPushEnvironment {
  send: (
    subscription: PushSubscriptionRecord,
    payload: string,
    vapidKeys: PushStateFile["vapidKeys"],
  ) => Promise<void>;
  loadState: () => PushStateFile | null;
  saveState: (state: PushStateFile) => void;
  generateVapidKeys: () => PushStateFile["vapidKeys"];
  listSessionNames: () => Promise<Map<string, string>>;
  /** Whether a remote subscriber's login is still let in; a revoked phone stops getting titles and prompts. */
  isLoginAllowed?: (login: string) => boolean;
}

/** What happened in a session: a run finished, failed, or is waiting on a dialog. */
export type SessionPushEvent =
  | { kind: "complete" }
  | { kind: "failed"; detail?: string }
  | { kind: "attention"; detail?: string };

export interface WebPushNotifier {
  getVapidPublicKey: () => string;
  addSubscription: (subscription: PushSubscriptionRecord) => void;
  removeSubscription: (endpoint: string) => boolean;
  hasSubscription: (endpoint: string) => boolean;
  notifySessionComplete: (sessionId: string) => Promise<void>;
  /** `sessionName`: the caller's copy of the title (null = untitled); omitted, it is looked up. */
  notifySessionEvent: (sessionId: string, event: SessionPushEvent, sessionName?: string | null) => Promise<void>;
  /** Send a test notification to one subscription; false when it is not registered. */
  sendTest: (endpoint: string) => Promise<boolean>;
}

function stateFilePath(): string {
  return join(getAgentDir(), "web-push.json");
}

/**
 * VAPID subject must be a valid `mailto:` or `https:` URL. Apple's push
 * service rejects requests whose subject is not a syntactically valid URL
 * (e.g. the previously used `mailto:pi-web@localhost`, which Apple answers
 * with 403 BadJwtToken), so default to the project homepage and let operators
 * override it via PI_WEB_PUSH_SUBJECT.
 */
export function vapidSubject(): string {
  const configured = process.env.PI_WEB_PUSH_SUBJECT?.trim();
  if (configured) return configured;
  return "https://github.com/agegr/pi-web";
}

// Ask the push service to deliver immediately. Lower urgencies let idle
// devices (especially iOS) defer delivery to an arbitrary later window.
export const PUSH_OPTIONS = { TTL: 2419200, urgency: "high" as const };

function getDefaultEnvironment(): WebPushEnvironment {
  return {
    async send(subscription, payload, vapidKeys) {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        payload,
        {
          vapidDetails: {
            subject: vapidSubject(),
            publicKey: vapidKeys.publicKey,
            privateKey: vapidKeys.privateKey,
          },
          TTL: PUSH_OPTIONS.TTL,
          urgency: PUSH_OPTIONS.urgency,
        },
      );
    },
    loadState() {
      const path = stateFilePath();
      if (!existsSync(path)) return null;
      try {
        return JSON.parse(readFileSync(path, "utf8")) as PushStateFile;
      } catch {
        return null;
      }
    },
    saveState(state) {
      const path = stateFilePath();
      mkdirSync(dirname(path), { recursive: true });
      writePrivateFileAtomicSync(path, JSON.stringify(state));
    },
    generateVapidKeys: () => webpush.generateVAPIDKeys(),
    isLoginAllowed: (login) => isTailscaleLoginAllowed(login),
    async listSessionNames() {
      const names = new Map<string, string>();
      try {
        for (const session of await SessionManager.listAll()) {
          if (session.name) names.set(session.id, session.name);
        }
      } catch {
        // Session list is best-effort; fall back to the generic title.
      }
      return names;
    },
  };
}

function pushStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

/**
 * Locale lookup for push payloads. The browser reports its UI locale when it
 * subscribes; unknown locales fall back to English.
 */
export function localeText(locale: string, key: "sessionComplete" | "taskFinished"): string {
  if (locale === "zh-CN") {
    const message = zhCNLocale.messages[key === "sessionComplete" ? "i18n.sessionComplete" : "i18n.taskFinished"];
    if (message) return message;
  }
  const message = enLocale.messages[key === "sessionComplete" ? "i18n.sessionComplete" : "i18n.taskFinished"];
  return message ?? (key === "sessionComplete" ? "Session complete" : "Task finished.");
}

type PushLocale = "en" | "zh-CN" | "zh-TW";

const EVENT_TEXT: Record<PushLocale, {
  failedTitle: string;
  failedBody: string;
  attentionTitle: string;
  attentionBody: string;
  testTitle: string;
  testBody: string;
}> = {
  en: {
    failedTitle: "Run failed",
    failedBody: "The run stopped with an error.",
    attentionTitle: "Waiting for you",
    attentionBody: "A session is waiting for your answer.",
    testTitle: "Pi notifications are on",
    testBody: "This device will be told when a session finishes, fails, or needs you.",
  },
  "zh-CN": {
    failedTitle: "运行失败",
    failedBody: "本次运行因错误而停止。",
    attentionTitle: "等待你处理",
    attentionBody: "有会话在等你回复。",
    testTitle: "Pi 通知已开启",
    testBody: "会话完成、失败或需要你处理时，这台设备会收到通知。",
  },
  "zh-TW": {
    failedTitle: "執行失敗",
    failedBody: "本次執行因錯誤而停止。",
    attentionTitle: "等待你處理",
    attentionBody: "有工作階段在等你回覆。",
    testTitle: "Pi 通知已開啟",
    testBody: "工作階段完成、失敗或需要你處理時，這台裝置會收到通知。",
  },
};

function pushLocale(locale: string): PushLocale {
  return locale === "zh-CN" || locale === "zh-TW" ? locale : "en";
}

/** Keep error text and dialog titles to one short line on a lock screen. */
function shortDetail(detail: string | undefined): string {
  const line = (detail ?? "").replace(/\s+/g, " ").trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

export function sessionPushPayload(
  sessionId: string,
  sessionName: string | undefined,
  event: SessionPushEvent,
  locale: string,
): { title: string; body: string; url: string; tag: string } {
  const url = `/?session=${encodeURIComponent(sessionId)}`;
  if (event.kind === "complete") {
    return {
      title: sessionName ?? localeText(locale, "sessionComplete"),
      body: localeText(locale, "taskFinished"),
      url,
      tag: `pi-session-complete:${sessionId}`,
    };
  }
  const text = EVENT_TEXT[pushLocale(locale)];
  const detail = shortDetail(event.detail);
  const label = event.kind === "failed" ? text.failedTitle : text.attentionTitle;
  return {
    title: sessionName ? `${label} · ${sessionName}` : label,
    body: detail || (event.kind === "failed" ? text.failedBody : text.attentionBody),
    url,
    // One notification per session: a newer state replaces the older one.
    tag: `pi-session-complete:${sessionId}`,
  };
}

export function createWebPushNotifier(environment: WebPushEnvironment): WebPushNotifier {
  const state: PushStateFile = (() => {
    const loaded = environment.loadState();
    if (loaded?.vapidKeys?.publicKey && loaded.vapidKeys.privateKey) return loaded;
    return { vapidKeys: environment.generateVapidKeys(), subscriptions: [] };
  })();
  const saveState = () => {
    environment.saveState(state);
  };

  // Gone subscriptions (404 / 410) are dropped; with `rethrow`, other failures reach the caller.
  const sendAll = async (
    subscriptions: PushSubscriptionRecord[],
    payloadFor: (locale: string) => object,
    rethrow = false,
  ) => {
    let pruned = false;
    try {
      for (const subscription of subscriptions) {
        try {
          await environment.send(subscription, JSON.stringify(payloadFor(subscription.locale)), state.vapidKeys);
        } catch (error) {
          const statusCode = pushStatusCode(error);
          if (statusCode === 404 || statusCode === 410) {
            state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
            pruned = true;
          }
          if (rethrow) throw error;
        }
      }
    } finally {
      if (pruned) saveState();
    }
  };

  const deliverable = (subscription: PushSubscriptionRecord) =>
    !subscription.login || (environment.isLoginAllowed?.(subscription.login) ?? false);

  const notifySessionEvent = async (sessionId: string, event: SessionPushEvent, knownName?: string | null) => {
    const recipients = state.subscriptions.filter(deliverable);
    if (recipients.length === 0) return;
    const sessionName = knownName !== undefined
      ? knownName ?? undefined
      : (await environment.listSessionNames()).get(sessionId);
    await sendAll(recipients, (locale) => sessionPushPayload(sessionId, sessionName, event, locale));
  };

  return {
    getVapidPublicKey() {
      saveState();
      return state.vapidKeys.publicKey;
    },
    addSubscription(subscription) {
      state.subscriptions = [
        ...state.subscriptions.filter((s) => s.endpoint !== subscription.endpoint),
        subscription,
      ];
      saveState();
    },
    removeSubscription(endpoint) {
      const before = state.subscriptions.length;
      state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== endpoint);
      if (state.subscriptions.length === before) return false;
      saveState();
      return true;
    },
    hasSubscription(endpoint) {
      return state.subscriptions.some((s) => s.endpoint === endpoint);
    },
    notifySessionComplete(sessionId) {
      return notifySessionEvent(sessionId, { kind: "complete" });
    },
    notifySessionEvent,
    async sendTest(endpoint) {
      const subscription = state.subscriptions.find((s) => s.endpoint === endpoint);
      if (!subscription || !deliverable(subscription)) return false;
      const text = EVENT_TEXT[pushLocale(subscription.locale)];
      await sendAll([subscription], () => ({ title: text.testTitle, body: text.testBody, url: "/", tag: "pi-push-test" }), true);
      return true;
    },
  };
}

declare global {
  var __piWebPushNotifier: Promise<WebPushNotifier> | undefined;
}

function getNotifier(): Promise<WebPushNotifier> {
  if (!globalThis.__piWebPushNotifier) {
    globalThis.__piWebPushNotifier = Promise.resolve().then(() => createWebPushNotifier(getDefaultEnvironment()));
  }
  return globalThis.__piWebPushNotifier;
}

export function getVapidPublicKey(): Promise<string> {
  return getNotifier().then((notifier) => notifier.getVapidPublicKey());
}

export function addSubscription(subscription: PushSubscriptionRecord): Promise<void> {
  return getNotifier().then((notifier) => notifier.addSubscription(subscription));
}

export async function notifySessionComplete(sessionId: string): Promise<void> {
  const notifier = await getNotifier();
  await notifier.notifySessionComplete(sessionId);
}

export async function notifySessionEvent(
  sessionId: string,
  event: SessionPushEvent,
  sessionName?: string | null,
): Promise<void> {
  const notifier = await getNotifier();
  await notifier.notifySessionEvent(sessionId, event, sessionName);
}

export function removeSubscription(endpoint: string): Promise<boolean> {
  return getNotifier().then((notifier) => notifier.removeSubscription(endpoint));
}

export function hasSubscription(endpoint: string): Promise<boolean> {
  return getNotifier().then((notifier) => notifier.hasSubscription(endpoint));
}

export function sendTestPush(endpoint: string): Promise<boolean> {
  return getNotifier().then((notifier) => notifier.sendTest(endpoint));
}
