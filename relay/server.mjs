// Pi relay: forwards end-to-end encrypted bytes between a desktop Pi and its
// paired phones. It never sees plaintext and never parses what it forwards; it
// only authenticates desktops (a signature over a fresh challenge), routes by
// agent id, and enforces limits. Design: docs/remote-relay.md.
//
//   desktop  wss://relay/agent              text: challenge / hello / ready, then binary
//   phone    wss://relay/client?agent=<id>  binary only (Noise messages)
//
// Desktop ⇄ relay binary frames: [kind: u8][client id: 16 bytes][payload]
//   kind 1 open (relay → desktop), 2 data (both ways),
//   3 close (both ways; from the desktop, payload byte 1 = not a paired device),
//   4 authenticated (desktop → relay: this phone proved itself; stranger limits end)

import { createHash, randomBytes, timingSafeEqual, webcrypto } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

export const KIND = { open: 1, data: 2, close: 3, auth: 4 };
/** Close codes phones see: 4001 means "this phone is not (or no longer) paired". */
export const CLOSE = { byDesktop: 4000, notPaired: 4001, slowDown: 4008, tooMuchBeforeAuth: 4013 };
const CLIENT_ID_BYTES = 16;
const PROTOCOL = "pi-relay-agent/1";

const SHELL_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
};

export function agentIdFor(spki) {
  return createHash("sha256").update(spki).digest("base64url").slice(0, 32);
}

function tokensEqual(a, b) {
  const x = createHash("sha256").update(String(a)).digest();
  const y = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(x, y);
}

function loadAgents(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return new Map(Object.entries(parsed.agents ?? {}));
  } catch {
    return new Map();
  }
}

function saveAgents(path, agents) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, agents: Object.fromEntries(agents) }, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** A fixed-window counter per key: at most `limit` events per `windowMs`. */
function rateLimiter(limit, windowMs) {
  const windows = new Map();
  return (key) => {
    const now = Date.now();
    const entry = windows.get(key);
    if (!entry || now - entry.start >= windowMs) {
      // Prune only expired windows: clearing everything would let one sender who
      // spreads over many keys reset everyone's limit.
      if (windows.size > 10000) for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
      windows.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

/**
 * @param {object} options
 * @param {string} [options.adminToken] needed to register a new desktop; without it none can register
 * @param {string} options.dataFile JSON file of registered desktops (agent id → public key)
 * @param {string} [options.shellDir] also serve the phone shell (weaker: the relay then serves trusted code)
 * @param {number} [options.maxClientsPerAgent] authenticated phones per desktop
 * @param {number} [options.maxStrangersPerAgent] phones not yet authenticated; the oldest is dropped for a newcomer
 * @param {number} [options.strangerBytes] what a phone may send before the desktop authenticates it
 * @param {number} [options.maxQueuedBytes] bytes waiting for a desktop before the sending phone is closed
 * @param {number} [options.maxMessageBytes]
 * @param {number} [options.connectionsPerMinute] per remote address
 * @param {number} [options.helloTimeoutMs]
 * @param {number} [options.pingIntervalMs]
 * @param {boolean} [options.trustProxy] take the client address from X-Forwarded-For (behind a TLS proxy)
 * @param {(line: string) => void} [options.log]
 */
export function createRelay(options) {
  const {
    adminToken = "",
    dataFile,
    shellDir = "",
    maxClientsPerAgent = 16,
    maxStrangersPerAgent = 8,
    strangerBytes = 256 * 1024,
    maxQueuedBytes = 16 * 1024 * 1024,
    maxMessageBytes = 70 * 1024,
    connectionsPerMinute = 60,
    helloTimeoutMs = 10_000,
    pingIntervalMs = 30_000,
    trustProxy = false,
    log = () => {},
  } = options;
  const agents = loadAgents(dataFile);
  /** agent id → { socket, clients: Map<hex id, socket> } */
  const online = new Map();
  const allowConnection = rateLimiter(connectionsPerMinute, 60_000);

  const addressOf = (request) => {
    // Behind a proxy that appends to X-Forwarded-For, only the last hop is its own.
    const forwarded = trustProxy ? request.headers["x-forwarded-for"]?.split(",").at(-1)?.trim() : "";
    return forwarded || request.socket.remoteAddress || "unknown";
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://relay");
    if (url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, agentsOnline: online.size }));
      return;
    }
    if (shellDir && request.method === "GET") {
      const relative = url.pathname === "/" ? "/__shell/index.html" : url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
      const file = normalize(join(shellDir, relative));
      if (file.startsWith(normalize(shellDir) + sep)) {
        try {
          const body = await readFile(file);
          response.writeHead(200, {
            "content-type": SHELL_TYPES[extname(file)] ?? "application/octet-stream",
            "cache-control": "no-cache",
            "x-content-type-options": "nosniff",
            ...(relative.endsWith("/sw.js") ? { "service-worker-allowed": "/" } : {}),
          });
          response.end(body);
          return;
        } catch {
          // fall through to 404
        }
      }
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes, perMessageDeflate: false });

  // Without a listener, a protocol error (oversized frame, bad opcode) from any
  // socket is an uncaught exception that takes the whole relay down. ws closes the
  // socket itself (1009, 1002); attach before anything else can run.
  const guarded = (accept) => (ws) => {
    ws.on("error", (error) => log(`socket error: ${error.message}`));
    accept(ws);
  };

  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    const url = new URL(request.url ?? "/", "http://relay");
    const address = addressOf(request);
    if (!allowConnection(address)) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return;
    }
    if (url.pathname === "/agent") {
      wss.handleUpgrade(request, socket, head, guarded((ws) => acceptAgent(ws, address)));
    } else if (url.pathname === "/client") {
      const agentId = url.searchParams.get("agent") ?? "";
      wss.handleUpgrade(request, socket, head, guarded((ws) => acceptClient(ws, agentId, address)));
    } else {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    }
  });

  function frame(kind, clientId, payload) {
    const out = Buffer.alloc(1 + CLIENT_ID_BYTES + (payload?.length ?? 0));
    out[0] = kind;
    clientId.copy(out, 1);
    if (payload) Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(out, 1 + CLIENT_ID_BYTES);
    return out;
  }

  function acceptAgent(ws, address) {
    const nonce = randomBytes(32).toString("base64url");
    let agentId = null;
    const timer = setTimeout(() => ws.close(4408, "hello timeout"), helloTimeoutMs);
    ws.send(JSON.stringify({ t: "challenge", nonce, protocol: PROTOCOL }));

    ws.on("message", async (data, isBinary) => {
      if (!agentId) {
        if (isBinary) return ws.close(4400, "expected hello");
        clearTimeout(timer);
        try {
          agentId = await verifyHello(JSON.parse(String(data)), nonce);
        } catch (error) {
          log(`agent refused from ${address}: ${error.message}`);
          return ws.close(4401, String(error.message).slice(0, 100));
        }
        const previous = online.get(agentId);
        if (previous) previous.socket.close(4409, "replaced by a newer connection");
        const entry = { socket: ws, clients: new Map() };
        online.set(agentId, entry);
        ws.send(JSON.stringify({ t: "ready", agentId }));
        log(`agent ${agentId} online`);
        return;
      }
      if (!isBinary || data.length < 1 + CLIENT_ID_BYTES) return;
      const entry = online.get(agentId);
      if (entry?.socket !== ws) return;
      const kind = data[0];
      const id = data.subarray(1, 1 + CLIENT_ID_BYTES).toString("hex");
      const client = entry.clients.get(id);
      if (!client) return;
      if (kind === KIND.data) client.send(data.subarray(1 + CLIENT_ID_BYTES), { binary: true });
      else if (kind === KIND.auth) client.authenticated = true;
      else if (kind === KIND.close) {
        const notPaired = data[1 + CLIENT_ID_BYTES] === 1;
        client.close(notPaired ? CLOSE.notPaired : CLOSE.byDesktop, notPaired ? "not paired" : "closed by desktop");
      }
    });

    ws.on("close", () => {
      clearTimeout(timer);
      const entry = agentId ? online.get(agentId) : null;
      if (entry?.socket === ws) {
        online.delete(agentId);
        for (const client of entry.clients.values()) client.close(4502, "desktop disconnected");
        log(`agent ${agentId} offline`);
      }
    });
    keepAlive(ws);
  }

  async function verifyHello(hello, nonce) {
    if (hello?.t !== "hello" || typeof hello.key !== "string" || typeof hello.sig !== "string") throw new Error("malformed hello");
    const spki = Buffer.from(hello.key, "base64url");
    if (spki.length > 200) throw new Error("malformed key");
    const agentId = agentIdFor(spki);
    if (!agents.has(agentId)) {
      if (!adminToken || typeof hello.admin !== "string" || !tokensEqual(hello.admin, adminToken)) {
        throw new Error("unknown desktop: registration needs the relay admin token");
      }
    } else if (agents.get(agentId) !== hello.key) {
      throw new Error("key mismatch");
    }
    const key = await webcrypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(hello.sig, "base64url"),
      new TextEncoder().encode(`${PROTOCOL}\n${nonce}`),
    );
    if (!ok) throw new Error("bad signature");
    if (!agents.has(agentId)) {
      agents.set(agentId, hello.key);
      saveAgents(dataFile, agents);
      log(`agent ${agentId} registered`);
    }
    return agentId;
  }

  function acceptClient(ws, agentId, address) {
    const entry = online.get(agentId);
    if (!entry) return ws.close(4404, "desktop offline");
    const clients = [...entry.clients.values()];
    if (clients.filter((c) => c.authenticated).length >= maxClientsPerAgent) return ws.close(4429, "too many phones");
    // Strangers (not yet authenticated by the desktop) cannot crowd out the owner: past
    // the cap the oldest stranger goes, so a new connection always gets its turn.
    const strangers = clients.filter((c) => !c.authenticated);
    if (strangers.length >= maxStrangersPerAgent) strangers[0].close(4429, "too many unauthenticated phones");
    const clientId = randomBytes(CLIENT_ID_BYTES);
    const key = clientId.toString("hex");
    ws.authenticated = false;
    ws.bytesBeforeAuth = 0;
    entry.clients.set(key, ws);
    entry.socket.send(frame(KIND.open, clientId), { binary: true });
    log(`phone connected to ${agentId} from ${address}`);

    ws.on("message", (data, isBinary) => {
      if (!isBinary) return ws.close(4400, "binary only");
      if (online.get(agentId) !== entry) return ws.close(4502, "desktop disconnected");
      if (!ws.authenticated) {
        ws.bytesBeforeAuth += data.length;
        if (ws.bytesBeforeAuth > strangerBytes) return ws.close(CLOSE.tooMuchBeforeAuth, "too much before authentication");
      }
      // The desktop is not keeping up: drop this phone rather than queue without bound.
      if (entry.socket.bufferedAmount > maxQueuedBytes) return ws.close(CLOSE.slowDown, "desktop busy");
      entry.socket.send(frame(KIND.data, clientId, data), { binary: true });
    });
    ws.on("close", () => {
      if (entry.clients.get(key) === ws) {
        entry.clients.delete(key);
        if (online.get(agentId) === entry) entry.socket.send(frame(KIND.close, clientId), { binary: true });
      }
    });
    keepAlive(ws);
  }

  const sockets = new Set();
  function keepAlive(ws) {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
  }
  const pinger = setInterval(() => {
    for (const ws of sockets) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, pingIntervalMs);
  pinger.unref();

  return {
    server,
    listen(port, host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    async close() {
      clearInterval(pinger);
      for (const ws of sockets) ws.terminate();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const relay = createRelay({
    adminToken: process.env.RELAY_ADMIN_TOKEN ?? "",
    dataFile: process.env.RELAY_DATA_FILE ?? join(process.cwd(), "data", "agents.json"),
    shellDir: process.env.RELAY_SHELL_DIR ?? "",
    trustProxy: process.env.RELAY_TRUST_PROXY === "1",
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });
  const port = await relay.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? "0.0.0.0");
  console.log(`pi relay listening on ${port}${process.env.RELAY_ADMIN_TOKEN ? "" : " (no RELAY_ADMIN_TOKEN: new desktops cannot register)"}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => relay.close().then(() => process.exit(0)));
}
