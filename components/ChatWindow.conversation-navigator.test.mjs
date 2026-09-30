import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("tags user-turn wrappers with data-conversation-turn for navigator jumps", () => {
  assert.match(source, /conversationTurnByMessageIndex/);
  assert.match(
    source,
    /data-conversation-turn=\{conversationTurn\}/,
    "selectConversationTurn queries [data-conversation-turn]; wrappers must set it",
  );
});

test("expands the lazy window then scrolls after the turn anchor mounts", () => {
  assert.match(source, /setPendingTurnScroll\(turnIndex\)/);
  assert.match(
    source,
    /setVisibleCount\(\(current\) => Math\.max\(current, messages\.length \* 2\)\)/,
  );
  assert.match(
    source,
    /querySelector<HTMLElement>\(`\[data-conversation-turn="\$\{pendingTurnScroll\}"\]`\)/,
  );
});
