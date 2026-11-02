import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./web-push.ts");
}

const { createWebPushNotifier, localeText } = await loadSubject();

function makeEnvironment({
  initialState = null,
  sessionNames = new Map([["session-1", "My session"]]),
  errorFor = () => null,
} = {}) {
  let state = initialState;
  let saved = null;
  const sent = [];

  const env = {
    send: async (subscription, payload, vapidKeys) => {
      sent.push({ subscription, payload, vapidKeys });
      const error = errorFor(subscription);
      if (error) throw error;
    },
    loadState: () => state,
    saveState: (s) => { saved = s; },
    generateVapidKeys: () => ({ publicKey: "pub-key", privateKey: "priv-key" }),
    listSessionNames: async () => sessionNames,
  };

  return {
    notifier: createWebPushNotifier(env),
    sent,
    getSaved: () => saved,
  };
}

const SUB_EN = {
  endpoint: "https://push.example.com/en",
  keys: { p256dh: "p256dh-en", auth: "auth-en" },
  locale: "en",
};
const SUB_ZH = {
  endpoint: "https://push.example.com/zh",
  keys: { p256dh: "p256dh-zh", auth: "auth-zh" },
  locale: "zh-CN",
};

test("generates and persists VAPID keys when no state exists", () => {
  const { notifier, getSaved } = makeEnvironment();

  assert.equal(notifier.getVapidPublicKey(), "pub-key");
  assert.deepEqual(getSaved(), {
    vapidKeys: { publicKey: "pub-key", privateKey: "priv-key" },
    subscriptions: [],
  });
});

test("reuses persisted VAPID keys", () => {
  const { notifier } = makeEnvironment({
    initialState: {
      vapidKeys: { publicKey: "persisted-pub", privateKey: "persisted-priv" },
      subscriptions: [],
    },
  });

  assert.equal(notifier.getVapidPublicKey(), "persisted-pub");
});

test("addSubscription upserts by endpoint and persists", () => {
  const { notifier, getSaved } = makeEnvironment();

  notifier.addSubscription(SUB_EN);
  notifier.addSubscription(SUB_ZH);
  notifier.addSubscription({ ...SUB_EN, locale: "zh-CN" });

  const saved = getSaved();
  assert.equal(saved.subscriptions.length, 2);
  const updated = saved.subscriptions.find((s) => s.endpoint === SUB_EN.endpoint);
  assert.equal(updated.locale, "zh-CN");
});

test("addSubscription persists even after getVapidPublicKey already saved", () => {
  const { notifier, getSaved } = makeEnvironment();

  notifier.getVapidPublicKey(); // first save
  notifier.addSubscription(SUB_EN);

  assert.equal(getSaved().subscriptions.length, 1);
});

test("notifySessionComplete sends localized payloads with the session name", async () => {
  const { notifier, sent } = makeEnvironment();
  notifier.addSubscription(SUB_EN);
  notifier.addSubscription(SUB_ZH);

  await notifier.notifySessionComplete("session-1");

  assert.equal(sent.length, 2);
  const en = sent.find((s) => s.subscription.endpoint === SUB_EN.endpoint);
  const zh = sent.find((s) => s.subscription.endpoint === SUB_ZH.endpoint);
  assert.deepEqual(JSON.parse(en.payload), {
    title: "My session",
    body: "Task finished.",
    url: "/?session=session-1",
    tag: "pi-session-complete:session-1",
  });
  assert.deepEqual(JSON.parse(zh.payload), {
    title: "My session",
    body: "任务已完成。",
    url: "/?session=session-1",
    tag: "pi-session-complete:session-1",
  });
});

test("notifySessionComplete falls back to the localized generic title", async () => {
  const { notifier, sent } = makeEnvironment({ sessionNames: new Map() });
  notifier.addSubscription(SUB_ZH);

  await notifier.notifySessionComplete("unknown-session");

  assert.deepEqual(JSON.parse(sent[0].payload), {
    title: "任务完成",
    body: "任务已完成。",
    url: "/?session=unknown-session",
    tag: "pi-session-complete:unknown-session",
  });
});

test("notifySessionComplete prunes subscriptions dropped by the push service", async () => {
  const { notifier, sent, getSaved } = makeEnvironment({
    errorFor: (subscription) => subscription.endpoint === SUB_ZH.endpoint ? { statusCode: 410 } : null,
  });
  notifier.addSubscription(SUB_EN);
  notifier.addSubscription(SUB_ZH);

  await notifier.notifySessionComplete("session-1");

  assert.equal(sent.length, 2);
  const saved = getSaved();
  assert.deepEqual(saved.subscriptions.map((s) => s.endpoint), [SUB_EN.endpoint]);
});

test("localeText falls back to English for unknown locales", () => {
  assert.equal(localeText("zh-CN", "taskFinished"), "任务已完成。");
  assert.equal(localeText("ja", "taskFinished"), "Task finished.");
  assert.equal(localeText("en", "sessionComplete"), "Session complete");
});

test("push requests immediate delivery with a long TTL", async () => {
  const { PUSH_OPTIONS } = await loadSubject();

  // iOS may defer non-high-urgency pushes to an arbitrary later window.
  assert.equal(PUSH_OPTIONS.urgency, "high");
  assert.equal(PUSH_OPTIONS.TTL, 2419200);
});

test("vapidSubject defaults to a valid https URL, not mailto:localhost", async () => {
  const { vapidSubject } = await loadSubject();
  const subject = vapidSubject();
  assert.doesNotMatch(subject, /@localhost$/);
  assert.ok(subject.startsWith("https://") || subject.startsWith("mailto:"), subject);
});

test("failed and waiting pushes name the session and carry a short detail", async () => {
  const { notifier, sent } = makeEnvironment();
  notifier.addSubscription(SUB_EN);
  notifier.addSubscription({ ...SUB_ZH, locale: "zh-TW", endpoint: "https://push.example.com/tw" });

  await notifier.notifySessionEvent("session-1", { kind: "failed", detail: `429\n${"x".repeat(300)}` });
  const [en, tw] = sent.map((entry) => JSON.parse(entry.payload));
  assert.equal(en.title, "Run failed · My session");
  assert.ok(en.body.startsWith("429 x"));
  assert.ok(en.body.length <= 140);
  assert.equal(tw.title, "執行失敗 · My session");
  assert.equal(en.url, "/?session=session-1");
  assert.equal(en.tag, "pi-session-complete:session-1", "a newer state replaces the older notification");

  sent.length = 0;
  await notifier.notifySessionEvent("other", { kind: "attention", detail: "" });
  assert.equal(JSON.parse(sent[0].payload).title, "Waiting for you");
  assert.equal(JSON.parse(sent[0].payload).body, "A session is waiting for your answer.");
});

test("sendTest reaches only the asking device; removeSubscription stops pushes", async () => {
  const { notifier, sent } = makeEnvironment();
  notifier.addSubscription(SUB_EN);
  notifier.addSubscription(SUB_ZH);

  assert.equal(await notifier.sendTest(SUB_ZH.endpoint), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subscription.endpoint, SUB_ZH.endpoint);
  assert.equal(JSON.parse(sent[0].payload).title, "Pi 通知已开启");
  assert.equal(await notifier.sendTest("https://push.example.com/unknown"), false);

  assert.equal(notifier.removeSubscription(SUB_ZH.endpoint), true);
  assert.equal(notifier.hasSubscription(SUB_ZH.endpoint), false);
  sent.length = 0;
  await notifier.notifySessionComplete("session-1");
  assert.deepEqual(sent.map((entry) => entry.subscription.endpoint), [SUB_EN.endpoint]);
});

test("sendTest surfaces a delivery error instead of swallowing it", async () => {
  const { notifier } = makeEnvironment({ errorFor: () => Object.assign(new Error("403 BadJwtToken"), { statusCode: 403 }) });
  notifier.addSubscription(SUB_EN);
  await assert.rejects(notifier.sendTest(SUB_EN.endpoint), /BadJwtToken/);
});

test("a caller-supplied session name skips the session scan", async () => {
  let scans = 0;
  const sent = [];
  const env = {
    send: async (subscription, payload) => { sent.push({ subscription, payload }); },
    loadState: () => null,
    saveState: () => {},
    generateVapidKeys: () => ({ publicKey: "p", privateKey: "k" }),
    listSessionNames: async () => { scans += 1; return new Map([["s", "Listed"]]); },
  };
  const counted = createWebPushNotifier(env);
  counted.addSubscription(SUB_EN);
  await counted.notifySessionEvent("s", { kind: "complete" }, "Live name");
  await counted.notifySessionEvent("s", { kind: "attention" }, null);
  assert.equal(scans, 0);
  assert.equal(JSON.parse(sent[0].payload).title, "Live name");
  assert.equal(JSON.parse(sent[1].payload).title, "Waiting for you", "null means untitled");
  await counted.notifySessionEvent("s", { kind: "complete" });
  assert.equal(scans, 1, "omitted, it falls back to the scan");
});

test("a phone's subscription stops receiving once its login is no longer let in", async () => {
  let allowed = new Set(["me@example.com"]);
  const sent = [];
  const notifier = createWebPushNotifier({
    send: async (subscription) => { sent.push(subscription.endpoint); },
    loadState: () => null,
    saveState: () => {},
    generateVapidKeys: () => ({ publicKey: "p", privateKey: "k" }),
    listSessionNames: async () => new Map(),
    isLoginAllowed: (login) => allowed.has(login),
  });
  notifier.addSubscription({ ...SUB_EN, endpoint: "https://push.example.com/desk" });
  notifier.addSubscription({ ...SUB_EN, endpoint: "https://push.example.com/phone", login: "me@example.com" });

  await notifier.notifySessionEvent("s", { kind: "complete" }, null);
  assert.deepEqual(sent.sort(), ["https://push.example.com/desk", "https://push.example.com/phone"]);

  allowed = new Set();
  sent.length = 0;
  await notifier.notifySessionEvent("s", { kind: "complete" }, null);
  assert.deepEqual(sent, ["https://push.example.com/desk"], "this computer's own browser keeps getting them");
  assert.equal(await notifier.sendTest("https://push.example.com/phone"), false);
});

test("a relay phone's subscription stops once the device is revoked", async () => {
  let paired = new Set(["dev-1"]);
  const sent = [];
  const notifier = createWebPushNotifier({
    send: async (subscription) => { sent.push(subscription.endpoint); },
    loadState: () => null,
    saveState: () => {},
    generateVapidKeys: () => ({ publicKey: "p", privateKey: "k" }),
    listSessionNames: async () => new Map(),
    isRelayDevicePaired: (id) => paired.has(id),
  });
  notifier.addSubscription({ ...SUB_EN, endpoint: "https://push.example.com/relay-phone", relayDevice: "dev-1" });
  await notifier.notifySessionEvent("s", { kind: "complete" }, null);
  assert.deepEqual(sent, ["https://push.example.com/relay-phone"]);
  paired = new Set();
  sent.length = 0;
  await notifier.notifySessionEvent("s", { kind: "complete" }, null);
  assert.deepEqual(sent, []);
});
