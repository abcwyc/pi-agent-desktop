import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createRelay } from "../../relay/server.mjs";

const { RelayConnector } = await import("./connector.ts");
const { PhoneTunnel, pairPhone, parsePairingTicket } = await import("./phone-client.ts");
const { generateKeyPair } = await import("./noise.ts");
const store = await import("./store.ts");
const { RELAY_MARK_HEADER, RELAY_DEVICE_HEADER, relayMarkSecret } = await import("./mark.ts");

const ADMIN = "relay-admin";
const SECRET_BODY = "top-secret-body-7f3a";

/** The local Pi server stand-in: echoes what reached it, streams SSE, records disconnects. */
async function startLocalServer() {
  const seen = { requests: [], disconnects: 0 };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.requests.push({ method: req.method, url: req.url, headers: req.headers, bodyLength: body.length });
      if (req.url === "/sse") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        let n = 0;
        const timer = setInterval(() => {
          n += 1;
          res.write(`data: ${n}\n\n`);
          if (n === 3) { clearInterval(timer); res.end(); }
        }, 150);
        res.on("close", () => clearInterval(timer));
        return;
      }
      if (req.url === "/forever") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: hello\n\n");
        res.on("close", () => { seen.disconnects += 1; });
        return;
      }
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.alloc(300_000, 7));
        return;
      }
      res.writeHead(201, { "content-type": "application/json", "set-cookie": "a=b", "x-echo": "1" });
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        bodySha: createHash("sha256").update(body).digest("hex"),
        mark: req.headers[RELAY_MARK_HEADER],
        device: req.headers[RELAY_DEVICE_HEADER],
        forwarded: req.headers["x-forwarded-for"] ?? null,
        cookie: req.headers.cookie ?? null,
        token: req.headers["x-pi-desktop-token"] ?? null,
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, seen, origin: `http://127.0.0.1:${server.address().port}` };
}

/** A man in the middle between phones and the relay that records every byte. */
async function startTap(relayUrl) {
  const recorded = [];
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (client, req) => {
    const upstream = new WebSocket(relayUrl + req.url);
    const pending = [];
    upstream.on("open", () => { for (const m of pending.splice(0)) upstream.send(m); });
    client.on("message", (data) => {
      recorded.push(Buffer.from(data));
      if (upstream.readyState === 1) upstream.send(data); else pending.push(data);
    });
    upstream.on("message", (data) => { recorded.push(Buffer.from(data)); client.send(data); });
    client.on("close", () => upstream.close());
    upstream.on("close", (code, reason) => client.close(code >= 4000 ? code : 1000, reason));
  });
  await new Promise((r) => wss.on("listening", r));
  return { wss, recorded, url: `ws://127.0.0.1:${wss.address().port}` };
}

async function setup(t, limits) {
  const dir = mkdtempSync(join(tmpdir(), "pi-relay-connector-"));
  const relay = createRelay({ adminToken: ADMIN, dataFile: join(dir, "relay-agents.json") });
  const port = await relay.listen(0, "127.0.0.1");
  const relayUrl = `ws://127.0.0.1:${port}`;
  const local = await startLocalServer();
  const tap = await startTap(relayUrl);
  const config = { enabled: true, url: relayUrl, entryUrl: "http://localhost:4200", adminToken: ADMIN };
  store.writeRelayConfig(dir, config);
  const identity = await store.loadOrCreateIdentity(dir);
  const connector = new RelayConnector({ dir, config, identity, localOrigin: () => local.origin, limits });
  connector.start();
  t.after(async () => {
    connector.stop();
    tap.wss.close();
    local.server.closeAllConnections();
    local.server.close();
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && connector.status().state !== "online"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(connector.status().state, "online");
  return { dir, connector, local, tap, relayUrl };
}

/** Pair a phone; the ticket's relay URL is swapped for the tap so its traffic is recorded. */
async function pairThroughTap(env, { approve = true, name = "Test phone", onCode } = {}) {
  const { url } = env.connector.createPairing();
  const ticket = parsePairingTicket(new URL(url).hash);
  ticket.relayUrl = env.tap.url;
  const device = await generateKeyPair();
  const paired = pairPhone({
    ticket, device, name,
    onWaitingForApproval: (code) => {
      onCode?.(code);
      setTimeout(async () => {
        const [pending] = env.connector.pendingPairings();
        if (approve) await env.connector.approvePairing(pending.id);
        else await env.connector.denyPairing(pending.id);
      }, 20);
    },
  });
  return { ticket, device, paired };
}

async function openTunnel(env, device) {
  const tunnel = new PhoneTunnel({ relayUrl: env.tap.url, agentId: env.connector.agentId, desktopKey: (await store.loadOrCreateIdentity(env.dir)).noisePublic, device });
  await tunnel.connect();
  return tunnel;
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

test("registration drops the admin token from disk once the relay knows this desktop", async (t) => {
  const env = await setup(t);
  assert.equal(store.readRelayConfig(env.dir).adminToken, undefined);
  assert.doesNotMatch(readFileSync(join(env.dir, "relay.json"), "utf8"), /relay-admin/);
});

test("pair with the QR ticket, approve on the desktop, then tunnel requests end to end", async (t) => {
  const env = await setup(t);
  const { device, paired } = await pairThroughTap(env, { name: "Lily's\nphone" });
  const { deviceId } = await paired;
  assert.equal(env.connector.devices().length, 1);
  assert.equal(env.connector.devices()[0].name, "Lily's phone", "control characters cleaned");
  assert.equal(env.connector.devices()[0].id, deviceId);

  const tunnel = await openTunnel(env, device);
  const body = new TextEncoder().encode(SECRET_BODY.repeat(5000));
  const response = await tunnel.request({
    method: "POST",
    url: "/echo?q=1",
    headers: [["content-type", "text/plain"], [RELAY_MARK_HEADER, "forged"], [RELAY_DEVICE_HEADER, "someone-else"],
      ["x-forwarded-for", "1.2.3.4"], ["cookie", "session=x"], ["x-pi-desktop-token", "stolen"]],
  }, body);
  assert.equal(response.head.status, 201);
  assert.equal(new Headers(response.head.headers).get("set-cookie"), null, "cookies are not carried");
  assert.equal(new Headers(response.head.headers).get("x-echo"), "1");
  const echo = JSON.parse(String(await readAll(response.body)));
  assert.equal(echo.method, "POST");
  assert.equal(echo.url, "/echo?q=1");
  assert.equal(echo.bodySha, createHash("sha256").update(body).digest("hex"), "a 100 KB body arrives intact");
  assert.equal(echo.mark, relayMarkSecret(), "the connector's own mark replaces the phone's");
  assert.equal(echo.device, deviceId);
  assert.equal(echo.cookie, null);
  assert.equal(echo.token, null);
  assert.notEqual(echo.forwarded, "1.2.3.4");
  tunnel.close();
});

test("responses stream as they are produced, and big ones arrive whole", async (t) => {
  const env = await setup(t);
  const { device, paired } = await pairThroughTap(env);
  await paired;
  const tunnel = await openTunnel(env, device);

  const { body } = await tunnel.request({ method: "GET", url: "/sse", headers: [] });
  const arrivals = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    arrivals.push({ at: Date.now(), text: new TextDecoder().decode(value) });
  }
  assert.deepEqual(arrivals.map((a) => a.text.trim()), ["data: 1", "data: 2", "data: 3"]);
  assert.ok(arrivals[2].at - arrivals[0].at >= 200, "events arrive spread out, not buffered to the end");

  const big = await tunnel.request({ method: "GET", url: "/big", headers: [] });
  const bytes = await readAll(big.body);
  assert.equal(bytes.length, 300_000);
  assert.ok(bytes.every((b) => b === 7));
  tunnel.close();
});

test("cancelling a request ends it on the desktop", async (t) => {
  const env = await setup(t);
  const { device, paired } = await pairThroughTap(env);
  await paired;
  const tunnel = await openTunnel(env, device);
  const controller = new AbortController();
  const { body } = await tunnel.request({ method: "GET", url: "/forever", headers: [] }, undefined, controller.signal);
  const reader = body.getReader();
  await reader.read();
  controller.abort();
  for (let i = 0; i < 50 && env.local.seen.disconnects === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(env.local.seen.disconnects, 1);
  tunnel.close();
});

test("the relay only ever sees ciphertext", async (t) => {
  const env = await setup(t);
  const { device, paired } = await pairThroughTap(env, { name: "Plaintext Phone Name" });
  await paired;
  const tunnel = await openTunnel(env, device);
  const response = await tunnel.request({ method: "POST", url: "/echo/very-identifiable-path", headers: [["x-marker", "header-marker-91"]] }, new TextEncoder().encode(SECRET_BODY));
  await readAll(response.body);
  tunnel.close();
  const everything = Buffer.concat(env.tap.recorded);
  assert.ok(everything.length > 500, "traffic was recorded");
  for (const needle of [SECRET_BODY, "very-identifiable-path", "header-marker-91", "Plaintext Phone Name", "bodySha", "application/json", relayMarkSecret()]) {
    assert.equal(everything.includes(Buffer.from(needle)), false, `relay saw "${needle}"`);
  }
});

test("an unpaired device key cannot open a session", async (t) => {
  const env = await setup(t);
  const stranger = await generateKeyPair();
  await assert.rejects(openTunnel(env, stranger));
  assert.equal(env.local.seen.requests.length, 0);
});

test("revoking a device closes its tunnel and keeps it out", async (t) => {
  const env = await setup(t);
  const { device, paired } = await pairThroughTap(env);
  const { deviceId } = await paired;
  const tunnel = await openTunnel(env, device);
  const closed = new Promise((r) => { tunnel.onClose = r; });
  assert.equal(env.connector.revokeDevice(deviceId), true);
  await closed;
  await assert.rejects(tunnel.request({ method: "GET", url: "/echo", headers: [] }));
  await assert.rejects(openTunnel(env, device));
});

test("a denied, reused or expired pairing ticket pairs nothing", async (t) => {
  const env = await setup(t);
  const denied = await pairThroughTap(env, { approve: false });
  await assert.rejects(denied.paired, /denied/);
  assert.equal(env.connector.devices().length, 0);

  // The same ticket again: refused even though the secret is right.
  await assert.rejects(pairPhone({ ticket: denied.ticket, device: await generateKeyPair(), name: "again" }));

  const { url } = env.connector.createPairing();
  const ticket = parsePairingTicket(new URL(url).hash);
  ticket.relayUrl = env.tap.url;
  for (const pairing of env.connector["pairings"].values()) pairing.expiresAt = Date.now() - 1;
  await assert.rejects(pairPhone({ ticket, device: await generateKeyPair(), name: "late" }));
  assert.equal(env.connector.devices().length, 0);
});

test("a ticket with a wrong secret fails without pairing", async (t) => {
  const env = await setup(t);
  const { url } = env.connector.createPairing();
  const ticket = parsePairingTicket(new URL(url).hash);
  ticket.relayUrl = env.tap.url;
  ticket.secret = crypto.getRandomValues(new Uint8Array(32));
  await assert.rejects(pairPhone({ ticket, device: await generateKeyPair(), name: "guess" }));
  assert.equal(env.connector.pendingPairings().length, 0);
});

test("a phone that finishes the pairing handshake without the secret never becomes a request", async (t) => {
  const env = await setup(t);
  const { url } = env.connector.createPairing();
  const ticket = parsePairingTicket(new URL(url).hash);
  const { HandshakeState } = await import("./noise.ts");
  const { relayPrologue } = await import("./phone-client.ts");
  // Speak the protocol by hand: a valid first message with a wrong psk, then stop.
  const ws = new WebSocket(`${env.tap.url}/client?agent=${env.connector.agentId}`);
  await new Promise((r) => ws.on("open", r));
  const state = await HandshakeState.create({
    pattern: "IKpsk2", initiator: true, prologue: relayPrologue(ticket.agentId),
    s: await generateKeyPair(), rs: ticket.desktopKey, psk: crypto.getRandomValues(new Uint8Array(32)),
  });
  const first = await state.writeMessage(new TextEncoder().encode("{}"));
  ws.send(Buffer.concat([Buffer.of(2), Buffer.from(ticket.pairingId), Buffer.from(first)]));
  await new Promise((r) => ws.once("message", r));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(env.connector.pendingPairings().length, 0, "no request without proof of the secret");
  // The real phone can still use the ticket: it was not burned.
  const device = await generateKeyPair();
  ticket.relayUrl = env.tap.url;
  const paired = pairPhone({ ticket, device, name: "real", onWaitingForApproval: () => setTimeout(async () => {
    await env.connector.approvePairing(env.connector.pendingPairings()[0].id);
  }, 20) });
  await paired;
  assert.equal(env.connector.devices().length, 1);
  ws.close();
});

/** Speak the phone side by hand: open a raw relay socket for this desktop. */
async function rawPhone(env) {
  const ws = new WebSocket(`${env.tap.url}/client?agent=${env.connector.agentId}`);
  const closed = new Promise((r) => ws.on("close", (code) => r(code)));
  const messages = [];
  ws.on("message", (m) => messages.push(m));
  await new Promise((r) => ws.on("open", r));
  return { ws, closed, messages };
}

test("an expired ticket gets no handshake reply at all", async (t) => {
  const env = await setup(t);
  const { url } = env.connector.createPairing();
  const ticket = parsePairingTicket(new URL(url).hash);
  for (const pairing of env.connector["pairings"].values()) pairing.expiresAt = Date.now() - 1;
  const { HandshakeState } = await import("./noise.ts");
  const { relayPrologue } = await import("./phone-client.ts");
  const phone = await rawPhone(env);
  const state = await HandshakeState.create({ pattern: "IKpsk2", initiator: true, prologue: relayPrologue(ticket.agentId), s: await generateKeyPair(), rs: ticket.desktopKey, psk: ticket.secret });
  phone.ws.send(Buffer.concat([Buffer.of(2), Buffer.from(ticket.pairingId), Buffer.from(await state.writeMessage(new Uint8Array(0)))]));
  await phone.closed;
  assert.equal(phone.messages.length, 0, "the desktop must not complete a handshake for an expired ticket");
});

test("a pairing phone that never proves the secret is closed after the handshake timeout", async (t) => {
  const env = await setup(t, { handshakeTimeoutMs: 300 });
  const { url } = env.connector.createPairing();
  const ticket = parsePairingTicket(new URL(url).hash);
  const { HandshakeState } = await import("./noise.ts");
  const { relayPrologue } = await import("./phone-client.ts");
  const phone = await rawPhone(env);
  const state = await HandshakeState.create({ pattern: "IKpsk2", initiator: true, prologue: relayPrologue(ticket.agentId), s: await generateKeyPair(), rs: ticket.desktopKey, psk: ticket.secret });
  phone.ws.send(Buffer.concat([Buffer.of(2), Buffer.from(ticket.pairingId), Buffer.from(await state.writeMessage(new Uint8Array(0)))]));
  const started = Date.now();
  const code = await phone.closed;
  assert.equal(code, 4000);
  assert.ok(Date.now() - started < 3000, "closed by the timeout, not left open");
});

test("unauthenticated phones are capped, and the owner still gets in afterwards", async (t) => {
  const env = await setup(t, { maxPendingHandshakes: 2 });
  const { device, paired } = await pairThroughTap(env);
  await paired;
  const idle = [await rawPhone(env), await rawPhone(env)];
  const third = await rawPhone(env);
  const started = Date.now();
  assert.equal(await third.closed, 4000);
  assert.ok(Date.now() - started < 2000, "a third unauthenticated phone is turned away at once, not by the 15 s timeout");
  for (const phone of idle) phone.ws.close();
  await Promise.all(idle.map((p) => p.closed));
  const tunnel = await openTunnel(env, device);
  const response = await tunnel.request({ method: "GET", url: "/echo", headers: [] });
  assert.equal(response.head.status, 201, "no lockout: the paired phone connects once slots free up");
  tunnel.close();
});

test("request bodies and requests in flight are capped per phone", async (t) => {
  const env = await setup(t, { maxRequestBody: 1000, maxStreams: 2 });
  const { device, paired } = await pairThroughTap(env);
  await paired;
  const tunnel = await openTunnel(env, device);
  await assert.rejects(tunnel.request({ method: "POST", url: "/echo", headers: [] }, new Uint8Array(5000)), /too large/);
  const held = [
    await tunnel.request({ method: "GET", url: "/forever", headers: [] }),
    await tunnel.request({ method: "GET", url: "/forever", headers: [] }),
  ];
  await assert.rejects(tunnel.request({ method: "GET", url: "/echo", headers: [] }), /too many requests/);
  for (const response of held) await response.body.cancel();
  tunnel.close();
});

test("the phone and the desktop show the same verification code", async (t) => {
  const env = await setup(t);
  const { url } = env.connector.createPairing();
  const ticket = parsePairingTicket(new URL(url).hash);
  ticket.relayUrl = env.tap.url;
  let phoneCode;
  const paired = pairPhone({ ticket, device: await generateKeyPair(), name: "p", onWaitingForApproval: (code) => { phoneCode = code; } });
  let pending;
  for (let i = 0; i < 200 && !pending; i++) {
    await new Promise((r) => setTimeout(r, 10));
    pending = env.connector.pendingPairings()[0];
  }
  assert.match(phoneCode, /^\d{6}$/);
  assert.equal(pending.code, phoneCode);
  await env.connector.approvePairing(pending.id);
  await paired;
});

test("a replayed first message never counts as a connected phone", async (t) => {
  const env = await setup(t, { handshakeTimeoutMs: 400 });
  const { device, paired } = await pairThroughTap(env);
  const { deviceId } = await paired;
  // Capture a real phone's first message off the wire, then replay it as the relay could.
  const tunnel = await openTunnel(env, device);
  tunnel.close();
  const firstMessage = env.tap.recorded.findLast((m) => m[0] === 1 && m.length > 80);
  const before = env.connector.devices().find((d) => d.id === deviceId).lastSeenAt;
  await new Promise((r) => setTimeout(r, 20));
  const replay = await rawPhone(env);
  replay.ws.send(firstMessage);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(env.connector.status().phones, 0, "not counted as connected");
  assert.equal(await replay.closed, 4000, "closed by the timeout");
  assert.equal(env.connector.devices().find((d) => d.id === deviceId).lastSeenAt, before, "last seen untouched");
});

test("revocation reaches the phone as 'not paired' (4001)", async (t) => {
  const env = await setup(t);
  const { device, paired } = await pairThroughTap(env);
  const { deviceId } = await paired;
  const tunnel = await openTunnel(env, device);
  const closed = new Promise((r) => { tunnel.onClose = r; });
  env.connector.revokeDevice(deviceId);
  assert.equal((await closed).code, 4001);
  const err = await openTunnel(env, device).catch((e) => e);
  assert.equal(err.code, 4001);
});

test("a duplicate end does not replay a request, and a bad header fails only its own request", async (t) => {
  const env = await setup(t, { maxStreams: 1 });
  const { device, paired } = await pairThroughTap(env);
  await paired;
  const tunnel = await openTunnel(env, device);
  await assert.rejects(tunnel.request({ method: "GET", url: "/echo", headers: [["x-bad", "a\r\nInjected: 1"]] }), /header|invalid/i);
  // The slot was freed: with maxStreams 1, another request still goes through.
  const ok = await tunnel.request({ method: "GET", url: "/echo", headers: [] });
  assert.equal(ok.head.status, 201);
  await ok.body.cancel();
  const before = env.local.seen.requests.length;
  const { FrameType, encodeJson } = await import("./frames.ts");
  await tunnel["sendFrame"](FrameType.RequestHead, 99, encodeJson({ method: "GET", url: "/echo", headers: [] }));
  await tunnel["sendFrame"](FrameType.RequestEnd, 99);
  await tunnel["sendFrame"](FrameType.RequestEnd, 99);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(env.local.seen.requests.length - before, 1, "replayed once");
  tunnel.close();
});

test("a new QR code retires an older one nobody used", async (t) => {
  const env = await setup(t);
  const first = parsePairingTicket(new URL(env.connector.createPairing().url).hash);
  env.connector.createPairing();
  first.relayUrl = env.tap.url;
  await assert.rejects(pairPhone({ ticket: first, device: await generateKeyPair(), name: "old" }));
  assert.equal(env.connector.pendingPairings().length, 0);
});

test("pairing tickets are refused when malformed", () => {
  assert.equal(parsePairingTicket("#pair=not-base64-json"), null);
  assert.equal(parsePairingTicket("#other=1"), null);
});
