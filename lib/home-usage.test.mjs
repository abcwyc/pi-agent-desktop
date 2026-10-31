import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeUsageRange, projectHomeUsage, summarizeHomeUsage } from "./home-usage.ts";
import { readHomeUsage } from "./home-usage-reader.ts";

const now = new Date("2026-10-30T12:00:00Z");
const assistant = (id, timestamp, usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }) => ({
  type: "message", id, timestamp,
  message: { role: "assistant", provider: "test", model: "model", usage, content: [{ type: "text", text: "private answer" }] },
});
const project = (entry) => projectHomeUsage(entry, "fallback");

test("copied fork ancestry is counted once; all token buckets contribute", () => {
  const entry = project(assistant("copy", "2026-10-29T08:00:00Z"));
  const result = summarizeHomeUsage([entry, { ...entry }], ["2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z"], "all", now);
  assert.equal(result.sessions, 2);
  assert.equal(result.messages, 1);
  assert.equal(result.tokens, 100);
  assert.equal(result.peakHour, 8);
  assert.equal(result.favoriteModel, "test/model");
  assert.equal(result.days[0].models["test/model"], 100, "fork copies must not duplicate chart stacks");
  assert.equal(Object.values(result.days[0].models).reduce((a, b) => a + b, 0), result.days[0].tokens);
});

test("seven days includes UTC midnight six days ago and excludes future records", () => {
  const timestamps = ["2026-10-23T23:59:59.999Z", "2026-10-24T00:00:00Z", "2026-10-30T12:00:00Z", "2026-10-30T12:00:01Z"];
  const result = summarizeHomeUsage(timestamps.map((time, i) => project(assistant(String(i), time))), timestamps, "7", now);
  assert.equal(result.messages, 2);
  assert.equal(result.tokens, 200);
  assert.equal(result.sessions, 2);
  assert.deepEqual(result.days.map((day) => day.date), ["2026-10-24", "2026-10-30"]);
});

test("missing usage stays unknown; recorded zero is distinguished from missing", () => {
  const missing = assistant("missing", "2026-10-29T00:00:00Z");
  delete missing.message.usage;
  assert.equal(summarizeHomeUsage([project(missing)], [], "all", now).tokens, null);
  const zero = project(assistant("zero", "2026-10-29T00:00:00Z", { input: 0, output: 0 }));
  assert.equal(summarizeHomeUsage([zero], [], "all", now).tokens, 0);
  assert.equal(summarizeHomeUsage([], [], "all", now).tokens, 0);
});

test("malformed, negative and non-finite usage cannot corrupt totals", () => {
  assert.equal(project({ type: "message", timestamp: "not a date", message: { role: "assistant" } }), null);
  for (const timestamp of [Infinity, NaN, 1e20]) {
    assert.equal(project({ type: "message", message: { role: "assistant", timestamp } }), null);
  }
  for (const value of [-1, Infinity, NaN, "100"]) {
    const record = project(assistant("bad", "2026-10-29T00:00:00Z", { input: value }));
    assert.equal(record.tokens, undefined);
  }
  assert.equal(project({ type: "message", timestamp: now.toISOString(), message: { role: "toolResult", content: "secret" } }), null);
});

test("compaction and usage entries contribute tokens without becoming messages", () => {
  const result = summarizeHomeUsage([
    project({ type: "compaction", id: "c", timestamp: "2026-10-29T00:00:00Z", usage: { input: 4, output: 6 } }),
    project({ type: "usage", id: "u", timestamp: "2026-10-29T00:00:00Z", model: "warm", usage: { cacheRead: 7 } }),
  ], [], "30", now);
  assert.equal(result.messages, 0);
  assert.equal(result.tokens, 17);
  assert.equal(result.peakHour, null);
  assert.equal(result.activeDays, 1);
});

test("only supported ranges reach the reader", () => {
  assert.equal(homeUsageRange(null), "all");
  assert.equal(homeUsageRange("30"), "30");
  assert.equal(homeUsageRange("7"), "7");
  for (const value of ["0", "-1", "365", "../", "NaN"]) assert.equal(homeUsageRange(value), null);
});

test("reader tolerates concurrent appends and missing files without returning private content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-home-usage-"));
  try {
    const path = join(dir, "session.jsonl");
    await writeFile(path, [JSON.stringify(assistant("a", "2026-10-29T00:00:00Z")), "{incomplete"].join("\n"));
    const copy = join(dir, "fork.jsonl");
    await writeFile(copy, JSON.stringify(assistant("a", "2026-10-29T00:00:00Z")) + "\n");
    const result = await readHomeUsage([path, copy, join(dir, "missing.jsonl")].map((path) => ({ path, created: "2026-10-29T00:00:00Z" })), "all", now);
    assert.equal(result.tokens, 100);
    assert.equal(result.messages, 1);
    assert.equal(result.skippedFiles, 1);
    assert.ok(!JSON.stringify(result).includes("private answer"));
    assert.ok(!JSON.stringify(result).includes(dir));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
