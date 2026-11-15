import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { collectSessionPrompts, scanSessionPrompts } = await createJiti(import.meta.url).import("./session-prompts.ts");

const t0 = Date.parse("2026-11-13T09:00:00Z");
const min = 60_000;

function writeSession(dir, name, entries) {
  const path = join(dir, name);
  writeFileSync(path, [
    { type: "session", version: 3, id: name, timestamp: new Date(t0).toISOString(), cwd: "/code/app" },
    ...entries,
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return path;
}

const message = (id, parentId, role, content, at) => ({
  type: "message", id, parentId, timestamp: new Date(at).toISOString(), message: { role, content, timestamp: at },
});

test("every prompt is listed with the last reply that descends from it, on every branch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-prompts-"));
  try {
    const path = writeSession(dir, "a.jsonl", [
      { type: "model_change", id: "m1", parentId: null, provider: "p", modelId: "x" },
      message("u1", "m1", "user", "First   question\nwith a newline", t0),
      message("a1", "u1", "assistant", [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }], t0 + 1),
      message("r1", "a1", "toolResult", [{ type: "text", text: "tool output" }], t0 + 2),
      message("a2", "r1", "assistant", [{ type: "text", text: "Answer one" }], t0 + 3),
      message("u2", "a2", "user", [{ type: "text", text: "Second question" }], t0 + 10 * min),
      // A branch from a1 that rewrote the first follow-up.
      message("u3", "a2", "user", "Branch question", t0 + 20 * min),
      message("a3", "u3", "assistant", [{ type: "text", text: "Branch answer" }], t0 + 21 * min),
      message("a4", "u2", "assistant", [{ type: "text", text: "Answer two" }], t0 + 11 * min),
      { type: "custom_message", id: "x1", parentId: "a4", customType: "note", content: "ignored" },
    ]);
    const prompts = await scanSessionPrompts(path);
    assert.deepEqual(prompts.map(({ entryId, text, reply }) => ({ entryId, text, reply })), [
      { entryId: "u1", text: "First question with a newline", reply: "Answer one" },
      { entryId: "u2", text: "Second question", reply: "Answer two" },
      { entryId: "u3", text: "Branch question", reply: "Branch answer" },
    ]);
    assert.equal(prompts[1].at, t0 + 10 * min);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only sessions active in the range are read, and only prompts in it are returned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-prompts-"));
  try {
    const day = 24 * 60 * min;
    const a = writeSession(dir, "a.jsonl", [
      message("u1", null, "user", "day one", t0),
      message("u2", "u1", "user", "day three", t0 + 2 * day),
    ]);
    const missing = join(dir, "missing.jsonl");
    const iso = (ms) => new Date(ms).toISOString();
    const result = await collectSessionPrompts([
      { id: "a", path: a, created: iso(t0), modified: iso(t0 + 2 * day) },
      // Outside the range by its dates: never opened, so a missing file does not matter.
      { id: "old", path: missing, created: iso(t0 - 10 * day), modified: iso(t0 - 9 * day) },
    ], t0 + day, t0 + 3 * day);
    assert.deepEqual(Object.keys(result), ["a"]);
    assert.deepEqual(result.a.map((prompt) => prompt.text), ["day three"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that is not a session yields nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-prompts-"));
  try {
    const path = join(dir, "x.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "message", id: "u", message: { role: "user", content: "hi" } })}\n`);
    assert.deepEqual(await scanSessionPrompts(path), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
