import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { describeStreamClient, streamAddress, streamClientLabel } = await jiti.import("./stream-client.ts");

const UA = {
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  androidChrome: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
};

test("a user agent becomes a browser and a system, never itself", () => {
  assert.equal(streamClientLabel(UA.macChrome), "Chrome · macOS");
  assert.equal(streamClientLabel(UA.macSafari), "Safari · macOS");
  // iOS browsers say Safari and Mac OS X too.
  assert.equal(streamClientLabel(UA.iphoneSafari), "Safari · iOS");
  assert.equal(streamClientLabel(UA.iphoneChrome), "Chrome · iOS");
  // Edge says Chrome; Android says Linux.
  assert.equal(streamClientLabel(UA.windowsEdge), "Edge · Windows");
  assert.equal(streamClientLabel(UA.androidChrome), "Chrome · Android");
  assert.equal(streamClientLabel(UA.linuxFirefox), "Firefox · Linux");
  assert.equal(streamClientLabel("curl/8.7.1"), null);
  assert.equal(streamClientLabel(null), null);
});

test("the address is the first forwarded entry, IPv4-mapped IPv6 shortened, junk dropped", () => {
  assert.equal(streamAddress("203.0.113.7, 10.0.0.1"), "203.0.113.7");
  assert.equal(streamAddress("::ffff:192.168.1.20"), "192.168.1.20");
  assert.equal(streamAddress("::1"), "::1");
  assert.equal(streamAddress("fe80::1%en0"), "fe80::1%en0");
  assert.equal(streamAddress(" "), null);
  assert.equal(streamAddress(null), null);
  assert.equal(streamAddress("<script>"), null);
  assert.equal(streamAddress("a".repeat(65)), null);
});

test("both from a request's headers", () => {
  const headers = new Headers({ "x-forwarded-for": "::ffff:127.0.0.1", "user-agent": UA.macChrome });
  assert.deepEqual(describeStreamClient(headers), { address: "127.0.0.1", client: "Chrome · macOS" });
  assert.deepEqual(describeStreamClient(new Headers()), { address: null, client: null });
});

test("the events route labels each stream with them", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");
  assert.match(route, /createAgentEventStream\(req, id, sessionPromise, \{ holder, \.\.\.describeStreamClient\(req\.headers\) \}\)/);
});
