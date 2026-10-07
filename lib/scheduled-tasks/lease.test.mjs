import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const lease = await createJiti(import.meta.url).import("./lease.ts");

function dir(t) {
  const path = mkdtempSync(join(tmpdir(), "pi-web-sched-lease-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const T0 = new Date("2026-10-07T10:00:00Z");
const plus = (ms) => new Date(T0.getTime() + ms);
const alive = () => true;
const dead = () => false;

test("the first process takes the lease and keeps it across heartbeats", (t) => {
  const d = dir(t);
  assert.equal(lease.acquireLease(d, { pid: 1, now: T0, alive }), true);
  assert.equal(lease.acquireLease(d, { pid: 1, now: plus(30_000), alive }), true);
  assert.equal(JSON.parse(readFileSync(lease.leasePath(d), "utf8")).startedAt, T0.toISOString());
});

test("a second live process is refused while the heartbeat is fresh", (t) => {
  const d = dir(t);
  lease.acquireLease(d, { pid: 1, now: T0, alive });
  assert.equal(lease.acquireLease(d, { pid: 2, now: plus(30_000), alive }), false);
});

test("a stale heartbeat or a dead owner can be taken over", (t) => {
  const d = dir(t);
  lease.acquireLease(d, { pid: 1, now: T0, alive });
  assert.equal(lease.acquireLease(d, { pid: 2, now: plus(30_000), alive: dead }), true);
  assert.equal(lease.acquireLease(d, { pid: 1, now: plus(31_000), alive }), false);
  // pid 2 stops heartbeating; after the stale window pid 1 takes it back.
  assert.equal(lease.acquireLease(d, { pid: 1, now: plus(30_000 + lease.LEASE_STALE_MS + 1), alive }), true);
});

test("only the owner can release", (t) => {
  const d = dir(t);
  lease.acquireLease(d, { pid: 1, now: T0, alive });
  lease.releaseLease(d, 2);
  assert.equal(existsSync(lease.leasePath(d)), true);
  lease.releaseLease(d, 1);
  assert.equal(existsSync(lease.leasePath(d)), false);
});

test("isPidAlive recognises this process and a long-gone one", () => {
  assert.equal(lease.isPidAlive(process.pid), true);
  assert.equal(lease.isPidAlive(2 ** 22 + 12345), false);
});
