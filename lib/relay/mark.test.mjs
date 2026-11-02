import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const mark = await import("./mark.ts");
const remote = await import("../remote-access.ts");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { proxy } = await jiti.import("../../proxy.ts");
const { isDesktopApiRequestAllowed } = await import("../desktop-api-auth.ts");

const secret = mark.relayMarkSecret();
const relayed = (extra = {}) => ({
  host: "127.0.0.1:38471",
  "x-forwarded-for": "127.0.0.1",
  [mark.RELAY_MARK_HEADER]: secret,
  [mark.RELAY_DEVICE_HEADER]: "AbCdEf0123456789",
  ...extra,
});

test("the mark is read back only with this process's secret and a sane device id", () => {
  const req = (headers) => new Request("http://127.0.0.1/", { headers });
  assert.equal(mark.readRelayMark(req({ host: "localhost" })), null);
  assert.deepEqual(mark.readRelayMark(req(relayed())), { deviceId: "AbCdEf0123456789" });
  assert.equal(mark.readRelayMark(req(relayed({ [mark.RELAY_MARK_HEADER]: "0".repeat(64) }))), "forged");
  assert.equal(mark.readRelayMark(req(relayed({ [mark.RELAY_DEVICE_HEADER]: "../../x" }))), "forged");
  const noDevice = relayed();
  delete noDevice[mark.RELAY_DEVICE_HEADER];
  assert.equal(mark.readRelayMark(req(noDevice)), "forged");
  assert.equal(mark.relayMarkSecret(), secret, "stable within the process");
});

test("a valid mark is refused unless the request came from the connector on this computer", () => {
  const req = (extra) => new Request("http://127.0.0.1/", { headers: relayed(extra) });
  assert.equal(mark.readRelayMark(req({ host: "192.168.1.9:38471" })), "forged", "LAN host");
  assert.equal(mark.readRelayMark(req({ host: "mac.tail1234.ts.net" })), "forged", "tailnet name");
  assert.equal(mark.readRelayMark(req({ "x-forwarded-for": "100.64.0.7" })), "forged", "relayed by a proxy");
  assert.equal(mark.readRelayMark(req({ "tailscale-user-login": "me@example.com" })), "forged", "through Tailscale Serve");
  assert.equal(mark.readRelayMark(req({ host: "localhost:38471" })), "forged", "the connector always uses 127.0.0.1");
});

test("the secret is not in the environment children inherit", () => {
  assert.equal(Object.values(process.env).includes(secret), false);
});

test("the proxy lets a genuine relay request through and refuses a forged one", () => {
  const ok = proxy(new NextRequest("http://127.0.0.1:38471/api/agent/tasks", { headers: relayed() }));
  assert.equal(ok.headers.get("x-middleware-next"), "1");
  const page = proxy(new NextRequest("http://127.0.0.1:38471/", { headers: relayed() }));
  assert.equal(page.headers.get("x-middleware-next"), "1");
  const forged = proxy(new NextRequest("http://127.0.0.1:38471/api/agent/tasks", { headers: relayed({ [mark.RELAY_MARK_HEADER]: "guess" }) }));
  assert.equal(forged.status, 403);
});

test("a relayed request is never local and never gets the desktop token routes", () => {
  const req = new Request("http://127.0.0.1/", { headers: relayed() });
  assert.equal(remote.isLocalRequest(req), false);
  const withToken = new Request("http://127.0.0.1/api/desktop/save", {
    method: "POST",
    headers: { ...relayed(), "x-pi-desktop-token": "t".repeat(40) },
  });
  assert.equal(isDesktopApiRequestAllowed(withToken, "t".repeat(40)), false);
});

test("every route that acts on this computer's screen or settings asks isLocalRequest, not the Host", () => {
  const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  for (const path of [
    "app/api/open-in-explorer/route.ts",
    "app/api/chat-downloads/reveal/route.ts",
    "app/api/chat-folder/reveal/route.ts",
    "app/api/remote-access/route.ts",
    "app/api/sessions/[id]/chat-access/route.ts",
  ]) {
    const source = read(path);
    assert.match(source, /isLocalRequest\(/, path);
    assert.doesNotMatch(source, /isLoopbackHost\(/, path);
  }
});
