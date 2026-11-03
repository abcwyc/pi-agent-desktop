// Tunnel service worker of the phone shell (docs/remote-relay.md). Scope "/" on
// the entry host. Every request the framed Pi app makes is handed to the shell
// page, which carries it through the encrypted session to the desktop.
// Served from the entry host, never the relay, so a relay cannot replace it.

const SHELL_PATH = "/__shell/";
const SHELL_PREFIX = "/__shell/";
const OWN_FILES = new Set(["/tunnel-sw.js"]);
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const SHELL_WAIT_MS = 20_000;
// A shell window that does not acknowledge a request this fast is gone (a reload
// can leave the unloading window listed for a moment); the next one is tried.
const ACK_MS = 2_000;
// The window whose tunnel last reported open. Lost when the worker sleeps; the
// acknowledgement fallback covers that.
let activeShellId = null;

self.addEventListener("message", (event) => {
  if (event.data?.type === "pi-shell-ready" && event.source) activeShellId = event.source.id;
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(SHELL_PREFIX) || OWN_FILES.has(url.pathname)) return;

  if (request.mode === "navigate") {
    // A navigation can come from any site (a link, a form). Only GET is ever
    // tunneled for one: a cross-site form POST must not reach the desktop.
    if (request.method !== "GET") {
      event.respondWith(new Response("Refused: cross-site form submission", { status: 403 }));
      return;
    }
    // A top-level visit (home-screen icon, notification, typed URL) opens the
    // shell, which frames the app at that path.
    // (The shell frames only app pages from ?path=, never /api/….)
    if (request.destination === "document") {
      event.respondWith(Response.redirect(`${SHELL_PATH}?path=${encodeURIComponent(url.pathname + url.search)}`, 302));
      return;
    }
  }
  event.respondWith(tunnel(request, url, event.clientId || event.resultingClientId));
});

/** Shell windows that may hold the tunnel, the one that last reported ready first. */
async function shellCandidates(skip) {
  const deadline = Date.now() + SHELL_WAIT_MS;
  for (;;) {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const shells = clients
      .filter((client) => new URL(client.url).pathname.startsWith(SHELL_PREFIX) && !skip.has(client.id))
      .sort((a, b) => (b.id === activeShellId) - (a.id === activeShellId)
        || (b.visibilityState === "visible") - (a.visibilityState === "visible"));
    if (shells.length || Date.now() > deadline) return shells;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function tunnel(request, url) {
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  const tried = new Set();
  for (let attempt = 0; attempt < 4; attempt++) {
    const [shell] = await shellCandidates(tried);
    if (!shell) break;
    tried.add(shell.id);
    const response = await sendToShell(shell, request, url, body);
    if (response) return response;
  }
  return new Response("Pi is not connected. Open Pi from the home screen.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** Resolves with the response, or null when this shell window did not acknowledge in time. */
function sendToShell(shell, request, url, body) {
  const { port1, port2 } = new MessageChannel();
  // The body is copied, not transferred: a retry on another window needs it again.
  shell.postMessage(
    { type: "pi-tunnel-request", method: request.method, url: url.pathname + url.search, headers: [...request.headers], body: body ? body.slice(0) : null },
    [port2],
  );
  return new Promise((resolve) => {
    let acknowledged = false;
    const ackTimer = setTimeout(() => {
      if (acknowledged) return;
      port1.close();
      resolve(null);
    }, ACK_MS);
    let controller = null;
    let settled = false;
    const stream = new ReadableStream({
      start(c) { controller = c; },
      cancel() { port1.postMessage({ type: "cancel" }); port1.close(); },
    });
    const cancel = () => port1.postMessage({ type: "cancel" });
    request.signal?.addEventListener("abort", cancel, { once: true });
    port1.onmessage = (event) => {
      const message = event.data;
      if (!acknowledged) {
        acknowledged = true;
        clearTimeout(ackTimer);
      }
      if (message.type === "ack") return;
      if (message.type === "head") {
        settled = true;
        resolve(new Response(NULL_BODY.has(message.status) ? null : stream, { status: message.status, headers: message.headers }));
      } else if (message.type === "chunk") {
        try { controller.enqueue(new Uint8Array(message.data)); } catch { /* reader gone */ }
      } else if (message.type === "end") {
        try { controller.close(); } catch { /* already closed */ }
        port1.close();
      } else if (message.type === "error") {
        if (!settled) {
          settled = true;
          resolve(new Response(message.message || "Request failed", { status: message.status || 502, headers: { "content-type": "text/plain; charset=utf-8" } }));
        } else {
          try { controller.error(new Error(message.message)); } catch { /* closed */ }
        }
        port1.close();
      }
    };
  });
}

// ---- Web Push (the desktop sends it directly; the relay is not involved) ----
// iOS revokes a subscription whose push shows no notification, so every push shows one.

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { /* malformed */ }
  const { title, body, url, tag } = payload;
  if (typeof title !== "string" || !title || typeof body !== "string" || !body) return;
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "/__shell/icon-192.png",
    data: { url: typeof url === "string" && url ? url : "/" },
    ...(typeof tag === "string" && tag ? { tag, renotify: true } : {}),
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let path = "/";
  try {
    const candidate = new URL(event.notification.data?.url ?? "/", self.location.origin);
    if (candidate.origin === self.location.origin) path = candidate.pathname + candidate.search;
  } catch { /* keep "/" */ }
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const shell = clients.find((client) => new URL(client.url).pathname.startsWith(SHELL_PREFIX));
    if (shell) {
      shell.postMessage({ type: "pi-open-path", path });
      try { await shell.focus(); return; } catch { /* fall through */ }
    }
    await self.clients.openWindow(`${SHELL_PATH}?path=${encodeURIComponent(path)}`);
  })());
});
