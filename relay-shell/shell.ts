import { exportPrivateKey, generateKeyPair, keyPairFromPrivate, type KeyPair } from "../lib/relay/noise.ts";
import { PhoneTunnel, pairPhone, parsePairingTicket, type PhoneConfig } from "../lib/relay/phone-client.ts";
import { safeAppPath } from "./paths.ts";

/**
 * The phone shell (docs/remote-relay.md): served by the entry host at /__shell/,
 * it holds the encrypted session to the desktop and frames the Pi app, whose
 * every request the tunnel service worker hands back here.
 */

const DB_NAME = "pi-relay";
const STORE = "config";
const KEY = "phone";

interface StoredConfig {
  relayUrl: string;
  agentId: string;
  desktopKey: Uint8Array;
  /** Non-extractable key, where the browser can keep a CryptoKey in IndexedDB. */
  devicePrivate?: CryptoKey;
  /** Raw private key, where it cannot (see canKeepCryptoKeys). */
  devicePrivateRaw?: Uint8Array;
  devicePublic: Uint8Array;
  deviceId: string;
  pairedAt: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet(): Promise<StoredConfig | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve((request.result as StoredConfig | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function dbPut(value: StoredConfig | null): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    if (value) tx.objectStore(STORE).put(value, KEY);
    else tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Whether a CryptoKey survives a round trip through IndexedDB here. Safari keeps
 * one by wrapping it with a keychain key; where that is unavailable (seen in
 * Playwright's WebKit) it stores null, and a non-extractable key would be lost on
 * the next launch. Then the device key is kept as raw bytes instead: same-origin
 * script could copy it rather than only use it, which is the price of not
 * silently forgetting the pairing.
 */
async function canKeepCryptoKeys(): Promise<boolean> {
  try {
    const probe = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]) as CryptoKeyPair;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ probe: probe.privateKey }, "probe");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const value = await new Promise<{ probe?: unknown } | undefined>((resolve) => {
      const request = db.transaction(STORE).objectStore(STORE).get("probe");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
    db.transaction(STORE, "readwrite").objectStore(STORE).delete("probe");
    return value?.probe instanceof CryptoKey;
  } catch {
    return false;
  }
}

function show(screen: "pair" | "unpaired" | "app" | "message", text?: string): void {
  for (const id of ["pair", "unpaired", "app", "message"]) $(`screen-${id}`).hidden = id !== screen;
  if (text !== undefined) $("message-text").textContent = text;
}

function setStatus(state: "connecting" | "open" | "offline", detail = ""): void {
  const pill = $("status");
  pill.dataset.state = state;
  $("status-text").textContent = state === "open" ? "Connected" : state === "connecting" ? "Connecting…" : `Offline${detail ? ` · ${detail}` : ""}`;
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  return "Browser";
}

// ---- requests from the tunnel service worker ----

let tunnel: PhoneTunnel | null = null;
const waitingForTunnel: (() => void)[] = [];

function tunnelReady(timeoutMs: number): Promise<PhoneTunnel | null> {
  if (tunnel?.state === "open") return Promise.resolve(tunnel);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    waitingForTunnel.push(() => {
      clearTimeout(timer);
      resolve(tunnel?.state === "open" ? tunnel : null);
    });
  });
}

async function serve(message: { method: string; url: string; headers: [string, string][]; body: ArrayBuffer | null }, port: MessagePort): Promise<void> {
  // A window without a pairing (a pairing page, say) never answers: the worker then
  // asks the window that has one instead of waiting on this one.
  if (!config) return;
  const controller = new AbortController();
  port.onmessage = (event) => { if (event.data?.type === "cancel") controller.abort(); };
  // Tell the worker this window is alive and has the request; it tries another window otherwise.
  port.postMessage({ type: "ack" });
  const ready = await tunnelReady(15_000);
  if (!ready) {
    port.postMessage({ type: "error", status: 503, message: "Not connected to your computer." });
    return;
  }
  try {
    const { head, body } = await ready.request(
      { method: message.method, url: message.url, headers: message.headers },
      message.body ? new Uint8Array(message.body) : undefined,
      controller.signal,
    );
    port.postMessage({ type: "head", status: head.status, headers: head.headers });
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.slice().buffer;
      port.postMessage({ type: "chunk", data: chunk }, [chunk]);
    }
    port.postMessage({ type: "end" });
  } catch (error) {
    if (!controller.signal.aborted) port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

navigator.serviceWorker?.addEventListener("message", (event) => {
  const data = event.data as { type?: string; path?: string };
  if (data?.type === "pi-tunnel-request" && event.ports[0]) {
    void serve(event.data, event.ports[0]);
  } else if (data?.type === "pi-open-path" && config) {
    ($("app-frame") as HTMLIFrameElement).src = safeAppPath(data.path);
  }
});

// ---- connection lifecycle ----

let config: PhoneConfig | null = null;
let retryMs = 1000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let connecting = false;

async function connect(): Promise<void> {
  if (!config || connecting || tunnel?.state === "open") return;
  connecting = true;
  if (retryTimer) clearTimeout(retryTimer);
  setStatus("connecting");
  const next = new PhoneTunnel(config);
  try {
    await next.connect();
    tunnel = next;
    retryMs = 1000;
    setStatus("open");
    navigator.serviceWorker.controller?.postMessage({ type: "pi-shell-ready" });
    for (const wake of waitingForTunnel.splice(0)) wake();
    next.onClose = (error) => {
      if (tunnel === next) tunnel = null;
      if (error.code === 4001) return showUnpaired();
      setStatus("offline", error.code === 4404 ? "computer offline" : "");
      scheduleReconnect();
    };
  } catch (error) {
    const code = (error as { code?: number }).code;
    // 4001: the desktop does not know this phone's key (removed). 4404: the desktop is
    // not connected to the relay. Anything else (limits, restarts) is worth a retry.
    if (code === 4001) return showUnpaired();
    setStatus("offline", code === 4404 ? "computer offline" : "");
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function showUnpaired(): void {
  setStatus("offline", "this phone was removed");
  show("message", "This phone is no longer paired with your computer. Pair it again from Settings › Remote relay on the computer.");
}

function scheduleReconnect(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void connect(), retryMs);
  retryMs = Math.min(retryMs * 2, 15_000);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && tunnel?.state !== "open") {
    retryMs = 1000;
    void connect();
  }
});
window.addEventListener("online", () => { retryMs = 1000; void connect(); });

async function registerWorker(): Promise<void> {
  await navigator.serviceWorker.register("/tunnel-sw.js", { scope: "/", updateViaCache: "none" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  }
}

function initialPath(): string {
  return safeAppPath(new URLSearchParams(location.search).get("path") ?? "/");
}

async function startApp(stored: StoredConfig): Promise<void> {
  const privateKey = stored.devicePrivate instanceof CryptoKey
    ? stored.devicePrivate
    : stored.devicePrivateRaw ? (await keyPairFromPrivate(stored.devicePrivateRaw, false)).privateKey : null;
  if (!privateKey) {
    show("message", "This phone lost its pairing key. Pair it again from Settings › Remote relay on the computer.");
    return;
  }
  config = {
    relayUrl: stored.relayUrl,
    agentId: stored.agentId,
    desktopKey: stored.desktopKey,
    device: { privateKey, publicKey: stored.devicePublic },
    deviceId: stored.deviceId,
  };
  show("app");
  $("status").hidden = false;
  await registerWorker();
  await connect();
  ($("app-frame") as HTMLIFrameElement).src = initialPath();
}

async function runPairing(ticketText: string): Promise<void> {
  const ticket = parsePairingTicket(ticketText);
  // The secret is in the fragment; drop it from the address bar and history now.
  history.replaceState(null, "", location.pathname);
  if (!ticket) {
    show("message", "This pairing link is not valid. Create a new QR code on your computer.");
    return;
  }
  // Any site can open a pairing link. Pairing over an existing pairing replaces this
  // phone's key and points it at another computer, so it has to be meant.
  const existing = await dbGet();
  const replace = $("pair-replace");
  replace.hidden = !existing;
  $<HTMLInputElement>("pair-replace-check").checked = false;
  show("pair");
  const nameInput = $<HTMLInputElement>("pair-name");
  nameInput.value = defaultDeviceName();
  const button = $<HTMLButtonElement>("pair-button");
  const status = $("pair-status");
  button.onclick = async () => {
    if (existing && !$<HTMLInputElement>("pair-replace-check").checked) {
      status.textContent = "This phone is already paired. Tick the box to replace that pairing, or close this page.";
      return;
    }
    button.disabled = true;
    status.textContent = "Connecting to your computer…";
    try {
      const keepKey = await canKeepCryptoKeys();
      const device: KeyPair = await generateKeyPair(!keepKey);
      const { deviceId } = await pairPhone({
        ticket,
        device,
        name: nameInput.value,
        onWaitingForApproval: (code) => {
          status.textContent = `On your computer, allow this phone only if it shows the code ${code.slice(0, 3)} ${code.slice(3)}.`;
        },
      });
      const stored: StoredConfig = {
        relayUrl: ticket.relayUrl,
        agentId: ticket.agentId,
        desktopKey: ticket.desktopKey,
        ...(keepKey ? { devicePrivate: device.privateKey } : { devicePrivateRaw: await exportPrivateKey(device) }),
        devicePublic: device.publicKey,
        deviceId,
        pairedAt: new Date().toISOString(),
      };
      await dbPut(stored);
      await startApp(stored);
    } catch (error) {
      status.textContent = error instanceof Error && error.message !== "relay connection closed (1006)"
        ? error.message
        : "Pairing failed. The QR code may have expired; create a new one on your computer.";
      button.disabled = false;
    }
  };
}

$("forget-button").addEventListener("click", async () => {
  if (!confirm("Unpair this phone? You will need to scan a new QR code on your computer.")) return;
  tunnel?.close();
  await dbPut(null);
  location.replace("/__shell/");
});
$("status").addEventListener("click", () => {
  const menu = $("menu");
  menu.hidden = !menu.hidden;
});
$("reconnect-button").addEventListener("click", () => {
  $("menu").hidden = true;
  retryMs = 1000;
  void connect();
});

async function main(): Promise<void> {
  // Framed by another page: refuse (no frame-ancestors from a static host's meta tags).
  if (window.top !== window.self) {
    document.body.textContent = "Pi cannot run inside another page.";
    return;
  }
  if (!("serviceWorker" in navigator) || !crypto?.subtle) {
    show("message", "This browser cannot run Pi remotely. Use Safari (iOS 17 or later) or a current Chrome.");
    return;
  }
  try {
    await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
  } catch {
    show("message", "This browser lacks X25519 encryption. Update to iOS 17 or later, or a current Chrome.");
    return;
  }
  if (location.hash.includes("pair=")) return runPairing(location.hash);
  const stored = await dbGet();
  if (stored) return startApp(stored);
  show("unpaired");
}

void main();
