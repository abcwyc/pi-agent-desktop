import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST: sessionStatsRoute } = await jiti.import("./stats/route.ts");
const { invalidateSessionListCache, invalidateSessionPathCache } = await jiti.import("../../../lib/session-reader.ts");

const JSON_HEADERS = { host: "localhost", "Content-Type": "application/json" };
const START = Date.parse("2026-10-01T00:00:00.000Z");

function post(body, headers = JSON_HEADERS) {
  return sessionStatsRoute(new Request("http://localhost/api/sessions/stats", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

function at(seconds) {
  return new Date(START + seconds * 1000).toISOString();
}

function usage(input, output, cost) {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}

function exchange(id, parentId, startSecond, { input, output, cost }) {
  return [
    { type: "message", id: `${id}-u`, parentId, timestamp: at(startSecond), message: { role: "user", content: "go", timestamp: START + startSecond * 1000 } },
    {
      type: "message", id: `${id}-a`, parentId: `${id}-u`, timestamp: at(startSecond + 30),
      message: { role: "assistant", content: [{ type: "toolCall", id: `${id}-t`, name: "read", arguments: {} }], usage: usage(input, output, cost), timestamp: START + (startSecond + 30) * 1000 },
    },
  ];
}

async function writeSession(sessionsDir, id, lines) {
  const path = join(sessionsDir, `${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp: at(0), cwd: "/work/alpha" };
  await writeFile(path, `${[header, ...lines].map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

async function scratchAgentDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-stats-route-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__piSessions = new Map();
  invalidateSessionListCache();
  const ids = [];
  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    for (const id of ids) invalidateSessionPathCache(id);
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });
  const sessionsDir = join(dir, "sessions", "--work-alpha--");
  await mkdir(sessionsDir, { recursive: true });
  return { sessionsDir, ids };
}

test("answers each session's tokens, cost, tool calls and active time, leaving out unknown ids", async (t) => {
  const { sessionsDir, ids } = await scratchAgentDir(t);
  ids.push("stats-main", "stats-child");
  await writeSession(sessionsDir, "stats-main", exchange("m", null, 0, { input: 1000, output: 200, cost: 0.02 }));
  const childPath = await writeSession(sessionsDir, "stats-child", exchange("c", null, 0, { input: 300, output: 50, cost: 0.004 }));

  const res = await post({ ids: ["stats-main", "stats-child", "stats-missing"] });
  assert.equal(res.status, 200);
  const { stats } = await res.json();
  assert.deepEqual(Object.keys(stats).sort(), ["stats-child", "stats-main"]);
  assert.deepEqual(stats["stats-main"].tokens, { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, total: 1200 });
  assert.equal(stats["stats-main"].cost, 0.02);
  assert.equal(stats["stats-main"].toolCalls, 1);
  assert.equal(stats["stats-main"].totalActiveMs, 30_000);
  assert.equal(stats["stats-child"].tokens.total, 350);

  // A later run's entries show up in the next poll.
  const more = exchange("c2", "c-a", 100, { input: 100, output: 10, cost: 0.001 });
  await appendFile(childPath, `${more.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const again = await (await post({ ids: ["stats-child"] })).json();
  assert.equal(again.stats["stats-child"].tokens.total, 460);
  assert.equal(again.stats["stats-child"].toolCalls, 2);
  assert.equal(again.stats["stats-child"].totalActiveMs, 60_000);
});

test("refuses malformed requests", async () => {
  assert.equal((await post({ ids: [] })).status, 400);
  assert.equal((await post({ ids: ["../etc"] })).status, 400);
  assert.equal((await post({ ids: Array.from({ length: 201 }, (_, i) => `s${i}`) })).status, 400);
  assert.equal((await post("{")).status, 400);
  assert.equal((await post({ ids: ["a"] }, { host: "localhost", "Content-Type": "text/plain" })).status, 415);
});
