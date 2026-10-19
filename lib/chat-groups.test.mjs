import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { chatRecencyGroup, groupChatFamilies, toggleId } = await jiti.import("./chat-groups.ts");

const NOW = new Date(2026, 9, 19, 15, 0, 0); // Mon 19 Oct 2026, local
const at = (days, hour = 9) => new Date(2026, 9, 19 - days, hour, 0, 0).toISOString();
const family = (id, days, hour) => ({ root: { id }, subagents: [], latestModified: at(days, hour) });

test("recency groups follow the local calendar day, not 24-hour windows", () => {
  assert.equal(chatRecencyGroup(at(0, 0), NOW), "today");
  assert.equal(chatRecencyGroup(at(1, 23), NOW), "week");
  assert.equal(chatRecencyGroup(at(6), NOW), "week");
  assert.equal(chatRecencyGroup(at(7), NOW), "earlier");
  assert.equal(chatRecencyGroup("not a date", NOW), "earlier");
});

test("pinned chats come first, then the rest by recency, each with its group", () => {
  const families = [family("old", 30), family("today", 0), family("week", 3), family("pinned-old", 40)];
  const { ordered, groupOf } = groupChatFamilies(families, new Set(["pinned-old"]), NOW);
  assert.deepEqual(ordered.map((f) => f.root.id), ["pinned-old", "today", "week", "old"]);
  assert.deepEqual(
    [...groupOf.entries()],
    [["pinned-old", "pinned"], ["today", "today"], ["week", "week"], ["old", "earlier"]],
  );
});

test("toggleId returns a new set and flips membership", () => {
  const base = new Set(["a"]);
  assert.deepEqual([...toggleId(base, "b")], ["a", "b"]);
  assert.deepEqual([...toggleId(base, "a")], []);
  assert.deepEqual([...base], ["a"]);
});
