import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "ALL_PROXY", "all_proxy"];
// The module captures the starting environment once, so clear it before the first import.
for (const key of PROXY_ENV_KEYS) delete process.env[key];

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const proxy = await jiti.import("./network-proxy.ts");
const { testNetworkProxy, classifyProxyTestError } = await jiti.import("./network-proxy-test.ts");
const { configureHttpDispatcher } = await jiti.import("./http-dispatcher.ts");

async function startProxyServer() {
  const forwarded = [];
  const server = createServer((req, res) => {
    forwarded.push(`${req.method} ${req.url}`);
    res.writeHead(204, { Connection: "close" });
    res.end();
  });
  // The app's dispatcher reaches http:// origins through a CONNECT tunnel too
  // (proxyTunnel in lib/http-dispatcher.ts), so answer the tunnelled request.
  server.on("connect", (req, socket) => {
    forwarded.push(`CONNECT ${req.url}`);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", (chunk) => {
      forwarded.push(`tunnel ${chunk.toString("latin1").split("\r\n", 1)[0]}`);
      socket.end("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
    });
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    forwarded,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("normalizes proxy addresses and rejects what undici cannot use", () => {
  assert.deepEqual(proxy.normalizeProxyUrl(" http://127.0.0.1:7890/ "), { ok: true, url: "http://127.0.0.1:7890" });
  assert.deepEqual(proxy.normalizeProxyUrl("127.0.0.1:7890"), { ok: true, url: "http://127.0.0.1:7890" });
  assert.deepEqual(proxy.normalizeProxyUrl("https://user:p%40ss@proxy.example:8443"), {
    ok: true,
    url: "https://user:p%40ss@proxy.example:8443",
  });
  assert.equal(proxy.normalizeProxyUrl("").ok, false);
  assert.match(proxy.normalizeProxyUrl("socks5://127.0.0.1:7891").error, /Unsupported proxy protocol socks5/);
  assert.match(proxy.normalizeProxyUrl("http://127.0.0.1:7890/path").error, /path/);
  assert.equal(proxy.normalizeProxyUrl("http://").ok, false);
});

test("the bypass list always keeps loopback off the proxy", () => {
  assert.equal(proxy.normalizeNoProxy(""), "localhost,127.0.0.1,::1");
  assert.equal(proxy.normalizeNoProxy("corp.local, 127.0.0.1  LOCALHOST,.internal"), "localhost,127.0.0.1,::1,corp.local,.internal");
});

test("redacts only the password", () => {
  assert.equal(proxy.redactProxyUrl("http://user:secret@127.0.0.1:7890"), "http://user:***@127.0.0.1:7890");
  assert.equal(proxy.redactProxyUrl("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
});

test("validates updates; an empty address is allowed only while switched off", () => {
  assert.deepEqual(proxy.parseNetworkProxyUpdate({ enabled: false, url: "" }), {
    ok: true,
    settings: { enabled: false, url: "", noProxy: "localhost,127.0.0.1,::1" },
  });
  assert.equal(proxy.parseNetworkProxyUpdate({ enabled: true, url: "" }).ok, false);
  assert.equal(proxy.parseNetworkProxyUpdate({ enabled: false, url: "ftp://x" }).ok, false);
  assert.equal(proxy.parseNetworkProxyUpdate({ enabled: "yes", url: "" }).ok, false);
  assert.deepEqual(proxy.parseNetworkProxyUpdate({ enabled: true, url: "127.0.0.1:7890", noProxy: "corp.local" }), {
    ok: true,
    settings: { enabled: true, url: "http://127.0.0.1:7890", noProxy: "localhost,127.0.0.1,::1,corp.local" },
  });
});

test("persists next to the other Pi Web settings and reads defaults from a broken file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-proxy-"));
  const path = join(dir, "pi-web", "settings.json");
  assert.deepEqual(proxy.readNetworkProxySettings(path), { enabled: false, url: "", noProxy: "localhost,127.0.0.1,::1" });
  const settings = { enabled: true, url: "http://127.0.0.1:7890", noProxy: "localhost,127.0.0.1,::1" };
  assert.deepEqual(proxy.writeNetworkProxySettings(settings, path), settings);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).networkProxy, settings);
  writeFileSync(path, "{broken");
  assert.equal(proxy.readNetworkProxySettings(path).enabled, false);
});

test("reads httpProxy from pi's settings.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-global-settings-"));
  const path = join(dir, "settings.json");
  assert.equal(proxy.readPiSettingsHttpProxy(path), null);
  writeFileSync(path, JSON.stringify({ httpProxy: " http://10.0.0.1:3128 " }));
  assert.equal(proxy.readPiSettingsHttpProxy(path), "http://10.0.0.1:3128");
});

test("switching the proxy on and off rewrites the environment and reroutes fetch without a restart", async (t) => {
  const server = await startProxyServer();
  t.after(async () => {
    for (const key of PROXY_ENV_KEYS) delete process.env[key];
    await server.close();
  });

  configureHttpDispatcher(2_000);

  const on = proxy.applyNetworkProxySettings(
    { enabled: true, url: server.url, noProxy: "bypass.invalid" },
    { piSettingsHttpProxy: null },
  );
  assert.deepEqual(on, { source: "settings", url: server.url, noProxy: "localhost,127.0.0.1,::1,bypass.invalid" });
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) assert.equal(process.env[key], server.url);
  assert.equal(process.env.no_proxy, "localhost,127.0.0.1,::1,bypass.invalid");

  const response = await fetch("http://target.invalid/through-proxy", { signal: AbortSignal.timeout(2_000) });
  assert.equal(response.status, 204);
  assert.deepEqual(server.forwarded, ["CONNECT target.invalid:80", "tunnel GET /through-proxy HTTP/1.1"]);
  const forwardedWhileOn = server.forwarded.length;

  const off = proxy.applyNetworkProxySettings(
    { enabled: false, url: server.url, noProxy: "" },
    { piSettingsHttpProxy: null },
  );
  assert.deepEqual(off, { source: "none", url: null, noProxy: "" });
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]) {
    assert.equal(process.env[key], undefined, key);
  }
  await assert.rejects(fetch("http://target.invalid/direct", { signal: AbortSignal.timeout(2_000) }));
  assert.equal(server.forwarded.length, forwardedWhileOn, "switched off, the request no longer reaches the proxy");

  const fromPi = proxy.applyNetworkProxySettings(
    { enabled: false, url: "", noProxy: "" },
    { piSettingsHttpProxy: "http://10.0.0.1:3128", reconfigure: false },
  );
  assert.deepEqual(fromPi, { source: "pi-settings", url: "http://10.0.0.1:3128", noProxy: "" });
});

test("the connection test reports success and readable failures", async (t) => {
  const server = await startProxyServer();
  t.after(() => server.close());

  const ok = await testNetworkProxy(server.url, { target: "http://target.invalid/generate_204", timeoutMs: 2_000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 204);

  const closed = await startProxyServer();
  const closedUrl = closed.url;
  await closed.close();
  const refused = await testNetworkProxy(closedUrl, { target: "http://target.invalid/", timeoutMs: 2_000 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "refused");

  assert.equal(classifyProxyTestError(new Error("Proxy response (407) !== 200 when HTTP Tunneling")).reason, "auth");
  assert.equal(classifyProxyTestError(new Error("Proxy response (502) !== 200 when HTTP Tunneling")).reason, "rejected");
  assert.equal(classifyProxyTestError(Object.assign(new Error("boom"), { cause: { code: "ENOTFOUND" } })).reason, "notFound");
});
