import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { KIND, agentIdFor, createRelay } from "./server.mjs";

const subtle = globalThis.crypto.subtle;
const ADMIN = "admin-token-for-tests";

async function startRelay(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-relay-test-"));
  const relay = createRelay({ adminToken: ADMIN, dataFile: join(dir, "agents.json"), ...extra });
  const port = await relay.listen(0, "127.0.0.1");
  return { relay, port, dir, url: `ws://127.0.0.1:${port}` };
}

function waitFor(ws, event) {
  return new Promise((resolve) => ws.once(event, (...args) => resolve(args)));
}

function nextMessage(ws) {
  return new Promise((resolve) => ws.once("message", (data, isBinary) => resolve({ data, isBinary })));
}

async function agentKeys() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = Buffer.from(await subtle.exportKey("spki", pair.publicKey));
  return { pair, spki, id: agentIdFor(spki) };
}

async function connectAgent(url, keys, { admin = ADMIN, signWith = keys } = {}) {
  const ws = new WebSocket(`${url}/agent`);
  const [challenge] = await waitFor(ws, "message");
  const { nonce } = JSON.parse(String(challenge));
  const sig = Buffer.from(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signWith.pair.privateKey,
    new TextEncoder().encode(`pi-relay-agent/1\n${nonce}`)));
  ws.send(JSON.stringify({ t: "hello", key: keys.spki.toString("base64url"), sig: sig.toString("base64url"), ...(admin ? { admin } : {}) }));
  const outcome = await Promise.race([
    nextMessage(ws).then(({ data }) => ({ ready: JSON.parse(String(data)) })),
    waitFor(ws, "close").then(([code, reason]) => ({ closed: code, reason: String(reason) })),
  ]);
  return { ws, ...outcome };
}

function connectClient(url, agentId) {
  const ws = new WebSocket(`${url}/client?agent=${encodeURIComponent(agentId)}`);
  // Captured now: the event can fire while the test is awaiting something else.
  ws.opened = waitFor(ws, "open");
  return ws;
}

test("health check", async (t) => {
  const { relay, port } = await startRelay();
  t.after(() => relay.close());
  const body = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
  assert.deepEqual(body, { ok: true, agentsOnline: 0 });
});

test("a new desktop registers only with the admin token, then reconnects without it", async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());
  const keys = await agentKeys();

  const refused = await connectAgent(url, keys, { admin: "" });
  assert.equal(refused.closed, 4401);
  assert.match(refused.reason, /admin token/);
  const wrong = await connectAgent(url, keys, { admin: "guess" });
  assert.equal(wrong.closed, 4401);

  const first = await connectAgent(url, keys);
  assert.deepEqual(first.ready, { t: "ready", agentId: keys.id });
  first.ws.close();
  await waitFor(first.ws, "close");

  const again = await connectAgent(url, keys, { admin: "" });
  assert.equal(again.ready?.agentId, keys.id);
  again.ws.close();
});

test("a relay without an admin token registers nobody", async (t) => {
  const { relay, url } = await startRelay({ adminToken: "" });
  t.after(() => relay.close());
  const outcome = await connectAgent(url, await agentKeys(), { admin: "" });
  assert.equal(outcome.closed, 4401);
});

test("a signature by another key is refused", async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());
  const keys = await agentKeys();
  const outcome = await connectAgent(url, keys, { signWith: await agentKeys() });
  assert.equal(outcome.closed, 4401);
  assert.match(outcome.reason, /bad signature/);
});

test("phones reach only their own desktop, both ways, with open and close", async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());
  const a = await connectAgent(url, await agentKeys());
  const bKeys = await agentKeys();
  const b = await connectAgent(url, bKeys);

  const bMessages = [];
  b.ws.on("message", (d) => bMessages.push(d));

  const phone = connectClient(url, a.ready.agentId);
  const open = await nextMessage(a.ws);
  assert.equal(open.data[0], KIND.open);
  const clientId = open.data.subarray(1, 17);
  await phone.opened;

  phone.send(Buffer.from("ciphertext-1"));
  const data = await nextMessage(a.ws);
  assert.equal(data.data[0], KIND.data);
  assert.deepEqual(data.data.subarray(1, 17), clientId);
  assert.equal(String(data.data.subarray(17)), "ciphertext-1");

  const reply = Buffer.concat([Buffer.of(KIND.data), clientId, Buffer.from("ciphertext-2")]);
  a.ws.send(reply);
  const got = await nextMessage(phone);
  assert.equal(String(got.data), "ciphertext-2");
  assert.equal(bMessages.length, 0, "the other desktop saw nothing");

  phone.close();
  const closed = await nextMessage(a.ws);
  assert.equal(closed.data[0], KIND.close);
  assert.deepEqual(closed.data.subarray(1, 17), clientId);
  a.ws.close();
  b.ws.close();
});

test("a desktop cannot write to another desktop's phone", async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());
  const a = await connectAgent(url, await agentKeys());
  const b = await connectAgent(url, await agentKeys());
  const phone = connectClient(url, a.ready.agentId);
  const open = await nextMessage(a.ws);
  await phone.opened;
  const received = [];
  phone.on("message", (d) => received.push(String(d)));
  b.ws.send(Buffer.concat([Buffer.of(KIND.data), open.data.subarray(1, 17), Buffer.from("forged")]));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(received, []);
  a.ws.close();
  b.ws.close();
});

test("the desktop can close a phone; a desktop going away closes its phones", async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());
  const a = await connectAgent(url, await agentKeys());
  const p1 = connectClient(url, a.ready.agentId);
  const open1 = await nextMessage(a.ws);
  await p1.opened;
  a.ws.send(Buffer.concat([Buffer.of(KIND.close), open1.data.subarray(1, 17)]));
  const [code1] = await waitFor(p1, "close");
  assert.equal(code1, 4000);

  const p2 = connectClient(url, a.ready.agentId);
  await nextMessage(a.ws);
  await p2.opened;
  a.ws.close();
  const [code2] = await waitFor(p2, "close");
  assert.equal(code2, 4502);
});

test("phones of an offline desktop and text frames are refused", async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());
  const [offline] = await waitFor(connectClient(url, "nobody"), "close");
  assert.equal(offline, 4404);
  const a = await connectAgent(url, await agentKeys());
  const p1 = connectClient(url, a.ready.agentId);
  await p1.opened;
  p1.send("plain text");
  const [textCode] = await waitFor(p1, "close");
  assert.equal(textCode, 4400);
  a.ws.close();
});

test("strangers cannot crowd out the owner: the oldest stranger makes room", async (t) => {
  const { relay, url } = await startRelay({ maxStrangersPerAgent: 2, maxClientsPerAgent: 1 });
  t.after(() => relay.close());
  const a = await connectAgent(url, await agentKeys());
  const opens = [];
  a.ws.on("message", (d) => { if (d[0] === KIND.open) opens.push(d.subarray(1, 17)); });
  const s1 = connectClient(url, a.ready.agentId);
  const s2 = connectClient(url, a.ready.agentId);
  await Promise.all([s1.opened, s2.opened]);
  const s1Closed = waitFor(s1, "close");
  const owner = connectClient(url, a.ready.agentId);
  await owner.opened;
  assert.equal((await s1Closed)[0], 4429, "the oldest stranger was dropped, the newcomer got in");
  // The desktop authenticates the owner; authenticated phones have their own cap.
  await new Promise((r) => setTimeout(r, 50));
  a.ws.send(Buffer.concat([Buffer.of(KIND.auth), opens[2]]));
  await new Promise((r) => setTimeout(r, 50));
  const second = connectClient(url, a.ready.agentId);
  await second.opened;
  owner.send(Buffer.from("still here"));
  const got = await new Promise((r) => a.ws.on("message", (d) => { if (d[0] === KIND.data) r(String(d.subarray(17))); }));
  assert.equal(got, "still here", "the authenticated owner is unaffected by newcomers");
  a.ws.close();
});

test("a stranger may send only so much before the desktop authenticates it", async (t) => {
  const { relay, url } = await startRelay({ strangerBytes: 1000 });
  t.after(() => relay.close());
  const a = await connectAgent(url, await agentKeys());
  const phone = connectClient(url, a.ready.agentId);
  await phone.opened;
  phone.send(Buffer.alloc(600));
  phone.send(Buffer.alloc(600));
  const [code] = await waitFor(phone, "close");
  assert.equal(code, 4013);
  a.ws.close();
});

test("the desktop says which closes mean 'not paired'", async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());
  const a = await connectAgent(url, await agentKeys());
  const phone = connectClient(url, a.ready.agentId);
  const open = await nextMessage(a.ws);
  await phone.opened;
  a.ws.send(Buffer.concat([Buffer.of(KIND.close), open.data.subarray(1, 17), Buffer.of(1)]));
  const [code] = await waitFor(phone, "close");
  assert.equal(code, 4001);
  a.ws.close();
});

test("a phone is closed rather than queued when its desktop is not reading", async (t) => {
  // Below zero, any queued byte counts as over the limit: the check runs on every message.
  const { relay, url } = await startRelay({ maxQueuedBytes: -1 });
  t.after(() => relay.close());
  const a = await connectAgent(url, await agentKeys());
  const phone = connectClient(url, a.ready.agentId);
  await phone.opened;
  phone.send(Buffer.from("x"));
  const [code] = await waitFor(phone, "close");
  assert.equal(code, 4008);
  a.ws.close();
});

test("a newer connection of the same desktop replaces the old one", async (t) => {
  const { relay, url } = await startRelay();
  t.after(() => relay.close());
  const keys = await agentKeys();
  const first = await connectAgent(url, keys);
  const second = await connectAgent(url, keys, { admin: "" });
  const [code] = await waitFor(first.ws, "close");
  assert.equal(code, 4409);
  const phone = connectClient(url, keys.id);
  const open = await nextMessage(second.ws);
  assert.equal(open.data[0], KIND.open);
  phone.close();
  second.ws.close();
});

test("connection attempts are rate limited per address", async (t) => {
  const { relay, url } = await startRelay({ connectionsPerMinute: 2 });
  t.after(() => relay.close());
  const results = [];
  for (let i = 0; i < 3; i++) {
    const ws = new WebSocket(`${url}/client?agent=x`);
    results.push(await Promise.race([
      waitFor(ws, "close").then(([code]) => `close ${code}`),
      waitFor(ws, "unexpected-response").then(([, res]) => `http ${res.statusCode}`),
      waitFor(ws, "error").then(() => "error"),
    ]));
  }
  assert.deepEqual(results.slice(0, 2), ["close 4404", "close 4404"]);
  assert.equal(results[2], "http 429");
});

test("oversized messages are refused", async (t) => {
  const { relay, url } = await startRelay({ maxMessageBytes: 1024 });
  t.after(() => relay.close());
  const a = await connectAgent(url, await agentKeys());
  const phone = connectClient(url, a.ready.agentId);
  await phone.opened;
  phone.send(Buffer.alloc(4096));
  const [code] = await waitFor(phone, "close");
  assert.equal(code, 1009);
  a.ws.close();
});

test("the optional shell is served without escaping its directory", async (t) => {
  const shellDir = mkdtempSync(join(tmpdir(), "pi-relay-shell-"));
  mkdirSync(join(shellDir, "__shell"));
  writeFileSync(join(shellDir, "__shell", "index.html"), "<p>shell</p>");
  writeFileSync(join(shellDir, "sw.js"), "// sw");
  const { relay, port } = await startRelay({ shellDir });
  t.after(async () => { await relay.close(); rmSync(shellDir, { recursive: true, force: true }); });
  const get = (path) => fetch(`http://127.0.0.1:${port}${path}`);
  assert.equal(await (await get("/__shell/")).text(), "<p>shell</p>");
  const sw = await get("/sw.js");
  assert.equal(sw.headers.get("service-worker-allowed"), "/");
  assert.equal((await get("/../../etc/passwd")).status, 404);
  assert.equal((await get("/%2e%2e/%2e%2e/etc/passwd")).status, 404);
});
