// Run: node --expose-gc lib/session-list-scanner.bench.mjs
// Synthetic files only. "No index" does not mean an empty OS filesystem cache.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, mkdtempSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const {
  // Index writes trail the scans; the child process below reads what this one wrote.
  flushSessionScanIndexForTests: flushIndex,
  listSessionsIncremental,
  resetSessionScanIndexForTests,
} = await jiti.import("./session-list-scanner.ts");
if (process.argv.includes("--persisted-index")) {
  assert.ok(process.env.PI_CODING_AGENT_DIR, "the parent benchmark must supply a temporary agent directory");
  const start = performance.now();
  const sessions = await listSessionsIncremental();
  console.log(JSON.stringify({ count: sessions.length, elapsed: performance.now() - start }));
  process.exit(0);
}
const root = mkdtempSync(join(tmpdir(), "pi-web-scanner-bench-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const count = 2000;
const timestamp = "2026-01-01T00:00:00.000Z";
const line = (entry) => JSON.stringify(entry) + "\n";
const message = line({ type: "message", timestamp, message: { role: "user", content: "x".repeat(1024) } });
const samples = new Map();
let bytes = 0;

function record(label, elapsed) {
  const values = samples.get(label) ?? [];
  values.push(elapsed);
  samples.set(label, values);
}

async function measure(label, scan, expectedCount = count) {
  globalThis.gc?.();
  const start = performance.now();
  const sessions = await scan();
  const elapsed = performance.now() - start;
  assert.equal(sessions.length, expectedCount);
  record(label, elapsed);
  return sessions;
}

// #1259: one long running session (multi-MB tool outputs inlined) appended to
// while the sidebar refetches the list. Every rescan used to parse it whole.
const bigLine = 4 * 1024 * 1024;
const bigLines = 24;
const smallPerBig = 1000;
async function largeActiveSession() {
  const largeRoot = mkdtempSync(join(tmpdir(), "pi-web-scanner-bench-large-"));
  process.env.PI_CODING_AGENT_DIR = largeRoot;
  resetSessionScanIndexForTests();
  try {
    const dir = join(largeRoot, "sessions", "project");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "large.jsonl");
    const fd = openSync(path, "w");
    let size = 0;
    let messages = 0;
    const put = (entry) => {
      size += writeSync(fd, line(entry));
      if (entry.type === "message") messages++;
    };
    try {
      put({ type: "session", version: 3, id: "large", cwd: largeRoot, timestamp });
      put({ type: "message", id: "u0", timestamp, message: { role: "user", content: "start the long task" } });
      // Tool output and replies with quotes, tabs and newlines: JSON escapes
      // make parsing cost what real transcripts cost.
      const output = 'src/app.ts:12:\tconst value = "result";\n'.repeat(bigLine / 32).slice(0, bigLine);
      const reply = 'Checked "file.ts":\n\t- line one\n'.repeat(50);
      for (let i = 0; i < bigLines; i++) {
        for (let j = 0; j < smallPerBig; j++) {
          put({ type: "message", id: `a${i}-${j}`, timestamp, message: { role: "assistant", content: [{ type: "text", text: reply }] } });
        }
        put({ type: "message", id: `t${i}`, timestamp, message: { role: "toolResult", toolCallId: `c${i}`, content: [{ type: "text", text: output }] } });
      }
    } finally {
      closeSync(fd);
    }
    const appended = line({ type: "message", id: "next", timestamp, message: { role: "assistant", content: [{ type: "text", text: "z".repeat(1024) }] } });
    const delay = monitorEventLoopDelay({ resolution: 5 });
    const blocked = [];
    await measure("Large session, no index", listSessionsIncremental, 1);
    for (let trial = 0; trial < 3; trial++) {
      appendFileSync(path, appended);
      messages++;
      delay.reset();
      delay.enable();
      const [session] = await measure("Large session, one appended line", listSessionsIncremental, 1);
      delay.disable();
      flushIndex();
      blocked.push(delay.max / 1e6);
      assert.equal(session.messageCount, messages);
    }
    return { size: size + 3 * Buffer.byteLength(appended), blocked };
  } finally {
    resetSessionScanIndexForTests();
    rmSync(largeRoot, { recursive: true, force: true });
    process.env.PI_CODING_AGENT_DIR = root;
  }
}

// Many short lines: per-line overhead of a full scan, not parsing.
const shortFiles = 300;
const shortLines = 3000;
async function manyShortLines() {
  const shortRoot = mkdtempSync(join(tmpdir(), "pi-web-scanner-bench-short-"));
  process.env.PI_CODING_AGENT_DIR = shortRoot;
  try {
    const dir = join(shortRoot, "sessions", "project");
    mkdirSync(dir, { recursive: true });
    const short = line({ type: "message", id: "m", timestamp, message: { role: "assistant", content: "ok" } });
    for (let i = 0; i < shortFiles; i++) {
      writeFileSync(join(dir, `${i}.jsonl`), line({ type: "session", version: 3, id: String(i), cwd: shortRoot, timestamp }) + short.repeat(shortLines));
    }
    for (let trial = 0; trial < 3; trial++) {
      rmSync(join(shortRoot, "pi-web-session-index.json"), { force: true });
      resetSessionScanIndexForTests();
      await measure("Short lines, no index", listSessionsIncremental, shortFiles);
    }
    return Buffer.byteLength(short);
  } finally {
    resetSessionScanIndexForTests();
    rmSync(shortRoot, { recursive: true, force: true });
    process.env.PI_CODING_AGENT_DIR = root;
  }
}

try {
  const dir = join(root, "sessions", "project");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const content = line({ type: "session", version: 3, id: String(i), cwd: root, timestamp }) + message.repeat(64);
    writeFileSync(join(dir, `${i}.jsonl`), content);
    bytes += Buffer.byteLength(content);
  }
  for (let trial = 0; trial < 3; trial++) {
    rmSync(join(root, "pi-web-session-index.json"), { force: true });
    resetSessionScanIndexForTests();
    await measure("SDK full scan", () => SessionManager.listAll());
    await measure("Scanner, no index", listSessionsIncremental);
    await measure("Scanner, memory index", listSessionsIncremental);
    flushIndex();
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--persisted-index"], {
      env: process.env, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    const persisted = JSON.parse(child.stdout);
    assert.equal(persisted.count, count);
    record("Scanner, persisted index (new process)", persisted.elapsed);
    appendFileSync(join(dir, "0.jsonl"), message);
    await measure("Scanner, one appended file", listSessionsIncremental);
  }
  const large = await largeActiveSession();
  const shortLine = await manyShortLines();
  console.log(`${count} synthetic sessions, ${(bytes / 1024 / 1024).toFixed(1)} MiB, 64 messages/file; three trials.`);
  console.log(`Large session: one ${(large.size / 1024 / 1024).toFixed(1)} MiB file, ${bigLines} lines of ${bigLine / 1024 / 1024} MiB; event loop blocked up to ${large.blocked.map((ms) => ms.toFixed(0)).join(", ")} ms per appended-line rescan.`);
  console.log(`Short lines: ${shortFiles} files of ${shortLines} lines, ${shortLine} B each.`);
  console.log("Scan latency only; excludes process startup, SDK imports, API project resolution, and browser rendering.");
  console.table([...samples].map(([mode, values]) => ({
    mode,
    medianMs: Number([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(1)),
    samplesMs: values.map((value) => value.toFixed(1)).join(", "),
  })));
} finally {
  resetSessionScanIndexForTests();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
