import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { orderChatFamilies, toggleId } = await jiti.import("./chat-groups.ts");

const family = (id, modified) => ({ root: { id }, subagents: [], latestModified: modified });

test("pinned chats come first, and each half is ordered by recency", () => {
  const families = [
    family("old", "2026-09-01T00:00:00Z"),
    family("new", "2026-10-19T00:00:00Z"),
    family("pinned-old", "2026-08-01T00:00:00Z"),
    family("pinned-new", "2026-10-01T00:00:00Z"),
  ];
  const ordered = orderChatFamilies(families, new Set(["pinned-old", "pinned-new"]));
  assert.deepEqual(ordered.map((f) => f.root.id), ["pinned-new", "pinned-old", "new", "old"]);
  // The input is left alone.
  assert.deepEqual(families.map((f) => f.root.id), ["old", "new", "pinned-old", "pinned-new"]);
});

test("without pins the order is plain recency", () => {
  const ordered = orderChatFamilies([family("a", "2026-01-01T00:00:00Z"), family("b", "2026-02-01T00:00:00Z")], new Set());
  assert.deepEqual(ordered.map((f) => f.root.id), ["b", "a"]);
});

test("toggleId returns a new set and flips membership", () => {
  const base = new Set(["a"]);
  assert.deepEqual([...toggleId(base, "b")], ["a", "b"]);
  assert.deepEqual([...toggleId(base, "a")], []);
  assert.deepEqual([...base], ["a"]);
});
