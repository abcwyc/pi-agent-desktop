import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Local-only actions are decided by isLocalRequest(), never by the Host header alone:
// a request Tailscale Serve forwarded must not count as this computer.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("changing remote access is local-only", () => {
  const source = read("app/api/remote-access/route.ts");
  assert.match(source, /export async function PUT[\s\S]*?if \(!isLocalRequest\(req\)\)/);
  assert.match(source, /local: isLocalRequest\(req\)/);
  assert.doesNotMatch(source, /isLoopbackHost/);
});

test("unlocking a chat is local-only and not offered remotely", () => {
  const source = read("app/api/sessions/[id]/chat-access/route.ts");
  assert.match(source, /if \(body\.unlocked && !isLocalRequest\(req\)\)/);
  assert.match(source, /describeChat\(id, isLocalRequest\(req\)\)/);
  assert.match(source, /available: Boolean\(folder\) && !isNetworkExposedServer\(\) && local/);
});
