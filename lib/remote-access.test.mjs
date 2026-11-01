import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const remote = await import("./remote-access.ts");
const security = await import("./request-security.ts");
const tailscale = await import("./tailscale-status.ts");

const HOST = "mac.tail1234.ts.net";
const config = { hostname: HOST, logins: ["me@example.com"] };

function tailnetRequest(headers = {}, method = "GET") {
  return new Request("http://127.0.0.1:38471/api/agent/running", {
    method,
    headers: { host: HOST, ...headers },
  });
}

test("normalizes what the user types to a bare tailnet name", () => {
  assert.equal(remote.normalizeRemoteHostname("https://Mac.Tail1234.ts.net/"), HOST);
  assert.equal(remote.normalizeRemoteHostname(" mac.tail1234.ts.net. "), HOST);
  assert.equal(remote.normalizeRemoteHostname("mac.tail1234.ts.net:443"), HOST);
  for (const rejected of ["", "localhost", "pi.localhost", "100.64.0.1", "[::1]", "mac", "https://mac.ts.net/path", "a b.ts.net", null, 3]) {
    assert.equal(remote.normalizeRemoteHostname(rejected), null, String(rejected));
  }
});

test("reads and writes the setting without touching other keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-remote-access-"));
  try {
    const path = join(dir, "pi-web", "settings.json");
    assert.equal(remote.readRemoteAccessConfig(path), null);

    remote.writeRemoteAccessConfig({ hostname: HOST, logins: ["Me@Example.com", "me@example.com", " "] }, path);
    assert.deepEqual(remote.readRemoteAccessConfig(path), config);

    const stored = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...stored, artifactsPrompt: false }));
    remote.writeRemoteAccessConfig(null, path);
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(after.artifactsPrompt, false);
    assert.equal("remoteAccess" in after, false);
    assert.equal(remote.readRemoteAccessConfig(path), null);

    writeFileSync(path, "{not json");
    assert.equal(remote.readRemoteAccessConfig(path), null, "an unreadable file means off");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolves the settings file like the pi SDK's agent dir", () => {
  assert.equal(remote.remoteAccessSettingsPath({ PI_CODING_AGENT_DIR: "/tmp/agent" }), join("/tmp/agent", "pi-web", "settings.json"));
});

test("a tailnet request needs a Tailscale user on the list", () => {
  assert.equal(remote.isRemoteAccessRequestAuthorized(tailnetRequest({ "tailscale-user-login": "me@example.com" }), config), true);
  assert.equal(remote.isRemoteAccessRequestAuthorized(tailnetRequest({ "tailscale-user-login": "ME@example.com" }), config), true);
  // Funnel and tagged devices: Serve adds no identity header.
  assert.equal(remote.isRemoteAccessRequestAuthorized(tailnetRequest(), config), false);
  assert.equal(remote.isRemoteAccessRequestAuthorized(tailnetRequest({ "tailscale-user-login": "other@example.com" }), config), false);
  assert.equal(remote.isRemoteAccessRequestAuthorized(
    tailnetRequest({ "tailscale-user-login": "other@example.com" }),
    { hostname: HOST, logins: [] },
  ), true, "an empty list lets in every tailnet user");
  assert.equal(remote.isRemoteAccessRequestAuthorized(
    new Request("http://x/", { headers: { host: "evil.example", "tailscale-user-login": "me@example.com" } }),
    config,
  ), false);
});

test("request-security admits the tailnet host only for an authorized Tailscale user", () => {
  const login = { "tailscale-user-login": "me@example.com" };
  assert.equal(security.isApiRequestHostAllowed(tailnetRequest(login), [], config), true);
  assert.equal(security.isApiRequestHostAllowed(tailnetRequest(), [], config), false);
  assert.equal(security.isApiRequestHostAllowed(tailnetRequest(login), [], null), false, "off by default");
});

test("the HTTPS origin Serve's browser sends counts as same-origin", () => {
  const login = { "tailscale-user-login": "me@example.com" };
  const post = (origin) => tailnetRequest({ ...login, origin, "sec-fetch-site": "same-origin" }, "POST");
  assert.equal(security.isApiRequestOriginAllowed(post(`https://${HOST}`), config), true);
  assert.equal(security.isApiRequestOriginAllowed(post("https://evil.example"), config), false);
  assert.equal(security.isApiRequestOriginAllowed(post(`https://${HOST}:8443`), config), false);
  assert.equal(security.isApiRequestOriginAllowed(
    tailnetRequest({ ...login, origin: "https://evil.example", "sec-fetch-site": "cross-site" }, "POST"),
    config,
  ), false);
});

test("parses tailscale status into the name and login the setting needs", () => {
  assert.deepEqual(tailscale.parseTailscaleStatus(JSON.stringify({
    BackendState: "Running",
    Self: { DNSName: "Mac.tail1234.ts.net.", UserID: 42 },
    User: { 42: { LoginName: "Me@Example.com" } },
  })), { state: "running", hostname: HOST, login: "me@example.com" });
  assert.deepEqual(tailscale.parseTailscaleStatus(JSON.stringify({
    BackendState: "NeedsLogin",
    Self: { DNSName: "", UserID: 0 },
  })), { state: "stopped", backendState: "NeedsLogin" });
});
