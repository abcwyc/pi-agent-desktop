// End to end through the encrypted relay, in Chromium and WebKit:
//   PI_WEB_DESKTOP_BUILD=1 node node_modules/next/dist/bin/next build --webpack
//   node e2e/relay.mjs [chromium|webkit ...]
// Starts the production Pi server (isolated agent dir), the relay, and the
// phone shell on its own static origin; pairs a phone from the QR link, uses
// the app through the tunnel, reloads, checks local-only routes and the
// cross-site form guard, then revokes the phone.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "playwright";
import { createRelay } from "../relay/server.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"];
const ADMIN = "e2e-admin-token";
const out = process.env.E2E_SCREENSHOTS ?? join(root, "test-results", "relay");

const free = async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
};

function serveStatic(dir) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" };
  return createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const relative = path.endsWith("/") ? `${path}index.html` : path;
    const file = normalize(join(dir, relative));
    if (!file.startsWith(dir + sep)) return res.writeHead(404).end();
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
}

const step = (name) => console.log(`  ✓ ${name}`);

async function waitFor(check, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const agentDir = mkdtempSync(join(tmpdir(), "pi-relay-e2e-agent-"));
const relayData = mkdtempSync(join(tmpdir(), "pi-relay-e2e-data-"));
const shellDir = mkdtempSync(join(tmpdir(), "pi-relay-e2e-shell-"));
let piServer;
let relay;
let shellServer;
let failed = false;
let currentPage = null;
let piLog = "";
const consoleLines = [];

try {
  console.log("building the shell");
  const built = spawnSync(process.execPath, [join(root, "scripts", "build-relay-shell.mjs"), "--out", shellDir], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);

  console.log("starting the relay and the entry host");
  relay = createRelay({ adminToken: ADMIN, dataFile: join(relayData, "agents.json") });
  const relayPort = await relay.listen(0, "127.0.0.1");
  shellServer = serveStatic(shellDir);
  const shellPort = await free();
  await new Promise((r) => shellServer.listen(shellPort, "127.0.0.1", r));
  // The entry host and the app share an origin only through the tunnel; "localhost"
  // keeps it a secure context, and 127.0.0.1 on the same port is a different site.
  const entry = `http://localhost:${shellPort}`;
  const otherSite = `http://127.0.0.1:${shellPort}`;

  console.log("starting the Pi server");
  const piPort = await free();
  const env = { ...process.env, NODE_ENV: "production", PI_WEB_DESKTOP_BUILD: "1", PI_CODING_AGENT_DIR: agentDir, PI_WEB_DISABLE_SCHEDULER: "1" };
  delete env.__NEXT_PRIVATE_ORIGIN;
  delete env.__NEXT_PRIVATE_STANDALONE_CONFIG;
  piServer = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(piPort)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  piServer.stdout.on("data", (d) => { piLog += d; });
  piServer.stderr.on("data", (d) => { piLog += d; });
  const pi = `http://127.0.0.1:${piPort}`;
  await waitFor(() => fetch(`${pi}/api/relay`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.ok), "the Pi server");
  console.log("servers up");

  const api = (path, init) => fetch(`${pi}${path}`, { ...init, signal: AbortSignal.timeout(20_000) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const configured = await api("/api/relay", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `ws://127.0.0.1:${relayPort}`, entryUrl: entry, enabled: true, adminToken: ADMIN }),
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  await waitFor(() => api("/api/relay").then((r) => r.body.status.state === "online"), "the desktop to come online");
  assert.equal((await api("/api/relay")).body.config.needsRegistration, false, "admin token dropped after registration");
  step("desktop registered with the relay and online");

  for (const engine of engines) {
    console.log(`[${engine}]`);
    const browser = await (engine === "webkit" ? webkit : chromium).launch();
    const context = await browser.newContext(engine === "webkit" ? { ...devices["iPhone 14"] } : { viewport: { width: 390, height: 844 }, isMobile: true });
    const page = await context.newPage();
    currentPage = page;
    page.on("console", (m) => consoleLines.push(`[${engine}] ${m.type()}: ${m.text()}`.slice(0, 240)));
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    const pairing = await api("/api/relay/pairing", { method: "POST" });
    assert.equal(pairing.status, 200);
    await page.goto(pairing.body.url);
    assert.equal(new URL(page.url()).hash, "", "the pairing secret leaves the address bar at once");
    await page.locator("#pair-name").fill(`${engine} phone`);
    await page.locator("#pair-button").click();
    const pending = await waitFor(() => api("/api/relay").then((r) => r.body.pending[0]), "the pairing request");
    assert.equal(pending.name, `${engine} phone`);
    await page.getByText("allow this phone only if it shows the code").waitFor();
    const phoneCode = (await page.locator("#pair-status").innerText()).match(/(\d{3}) (\d{3})/).slice(1).join("");
    assert.equal(phoneCode, pending.code, "the phone and the desktop show the same code");
    const approved = await api(`/api/relay/pairing/${pending.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve" }) });
    assert.equal(approved.status, 200);
    step("paired from the QR link after approval on the desktop");

    const frame = page.frameLocator("#app-frame");
    await frame.getByText("New Session").first().waitFor({ timeout: 60_000 });
    const app = page.frames().find((f) => f !== page.mainFrame());
    assert.equal(await app.evaluate(() => Boolean(navigator.serviceWorker.controller)), true);
    step("the Pi app loaded through the encrypted tunnel");

    const fromPhone = (path, init) => app.evaluate(async ([p, i]) => {
      const r = await fetch(p, i);
      return { status: r.status, body: await r.json().catch(() => null) };
    }, [path, init]);
    const post = await fromPhone("/api/push/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: "https://push.example.com/none" }) });
    assert.equal(post.status, 404, "a POST reaches its route through the relay mark");
    assert.equal((await fromPhone("/api/relay")).body.local, false, "the phone is never local");
    assert.equal((await fromPhone("/api/relay", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await fromPhone("/api/relay/pairing", { method: "POST" })).status, 403, "a phone cannot mint pairing links");
    assert.equal((await fromPhone("/api/remote-access", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hostname: null }) })).status, 403);
    assert.equal((await fromPhone("/api/relay/pairing/anything", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve" }) })).status, 403, "a phone cannot approve pairings");
    const ownId = (await api("/api/relay")).body.devices.find((d) => d.name === `${engine} phone`).id;
    assert.equal((await fromPhone(`/api/relay/devices/${ownId}`, { method: "DELETE" })).status, 403, "a phone cannot remove phones");
    assert.equal((await fromPhone("/api/sessions/any/chat-access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unlocked: true }) })).status, 403, "a phone cannot unlock a chat");
    step("POST works; relay, pairing, device, chat-unlock and remote-access changes stay local-only");

    const sse = await app.evaluate(() => new Promise((resolve) => {
      const es = new EventSource("/api/agent/running/events");
      const timer = setTimeout(() => { es.close(); resolve(null); }, 10_000);
      es.onmessage = (e) => { clearTimeout(timer); es.close(); resolve(JSON.parse(e.data)); };
    }));
    assert.ok(Array.isArray(sse?.runningSessionIds), "SSE delivers through the tunnel");
    step("server-sent events stream through the tunnel");

    await page.screenshot({ path: join(out, `${engine}-app.png`) });
    await page.reload();
    await page.frameLocator("#app-frame").getByText("New Session").first().waitFor({ timeout: 60_000 });
    step("reload reconnects with the stored device key, no new pairing");

    // A link from anywhere can open the shell with ?path=; it frames only app pages.
    await page.goto(`${entry}/__shell/?path=${encodeURIComponent("/api/relay")}`);
    await page.frameLocator("#app-frame").getByText("New Session").first().waitFor({ timeout: 60_000 });
    assert.equal(await page.locator("#app-frame").getAttribute("src"), "/", "?path=/api/… is not framed");
    step("an outside ?path= frames only app pages");

    // A pairing link on an already paired phone must not silently replace the pairing.
    const second = await api("/api/relay/pairing", { method: "POST" });
    await page.goto(second.body.url);
    await page.locator("#pair-replace").waitFor();
    await page.locator("#pair-button").click();
    await page.getByText("Tick the box to replace").waitFor();
    assert.equal((await api("/api/relay")).body.pending.length, 0, "nothing was sent without the tick");
    await page.goto(`${entry}/__shell/`);
    await page.frameLocator("#app-frame").getByText("New Session").first().waitFor({ timeout: 60_000 });
    step("a pairing link on a paired phone needs an explicit replace");

    // A page on another site posts a form to the entry host: the tunnel worker refuses it.
    const other = await context.newPage();
    // A plain page on the other site (the shell page's CSP would block any form).
    await other.goto(`${otherSite}/not-the-shell`);
    await other.setContent(`<form method="POST" action="${entry}/api/relay/pairing"><button>go</button></form>`);
    await Promise.all([other.waitForNavigation(), other.locator("button").click()]);
    assert.match(await other.locator("body").innerText(), /Refused: cross-site form submission/);
    await other.close();
    step("a cross-site form POST is refused by the tunnel worker");

    // Up to here nothing may fail on the page; removing the phone then cuts its open
    // streams on purpose, which the app sees like a server going away.
    assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
    const deviceId = (await api("/api/relay")).body.devices.find((d) => d.name === `${engine} phone`).id;
    assert.equal((await api(`/api/relay/devices/${deviceId}`, { method: "DELETE" })).status, 200);
    await page.reload();
    await page.getByText("no longer paired").waitFor({ timeout: 30_000 });
    step("a removed phone is shut out");

    await browser.close();
  }
  console.log("PASS");
} catch (error) {
  failed = true;
  console.error("FAIL:", error.message);
  // What the shell showed when it failed: the screen, the status pill, the frame, the console.
  const state = await currentPage?.evaluate(() => ({
    screen: [...document.querySelectorAll(".screen, #screen-app")].filter((s) => !s.hidden).map((s) => s.id),
    status: document.getElementById("status")?.dataset.state + " " + document.getElementById("status-text")?.textContent,
    frame: document.getElementById("app-frame")?.getAttribute("src"),
    controller: Boolean(navigator.serviceWorker.controller),
  })).catch((e) => `unavailable: ${e.message}`);
  console.error("shell state:", JSON.stringify(state));
  console.error(consoleLines.slice(-25).join("\n"));
  console.error("Pi server log (tail):\n" + piLog.split("\n").slice(-15).join("\n"));
} finally {
  piServer?.kill();
  shellServer?.close();
  await relay?.close();
  for (const dir of [agentDir, relayData, shellDir]) rmSync(dir, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}
