import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("offers compact quoting controls and sends questions to a side chat", async () => {
  const chatSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

  assert.match(chatSource, /onPointerUp=\{captureQuotedSelection\}/);
  assert.match(chatSource, /closest<HTMLElement>\("\[data-message-role=/);
  // Quote (C3): a plain Markdown quote at the composer caret, in a paragraph of its own.
  assert.match(chatSource, /chatInputRef\?\.current\?\.insertQuote\(buildQuotedSelection\(quotedSelection\.text\)\)/);
  // "Ask in side chat" (C1) replaced "Ask in new chat": a side chat named after the selection.
  assert.match(chatSource, /const refusal = await startSideChat\(prompt, quotedSelection\.text\);/);
  assert.doesNotMatch(chatSource, /onAskInNewChat/);
  // The Artifacts page's "continue in new chat" still forks and sends once it opens.
  assert.match(shellSource, /type: "fork_branch"/);
  assert.match(shellSource, /initialPrompt=\{pendingQuotePrompt\?\.sessionId === selectedSession\?\.id/);
  assert.equal((shellSource.match(/<ChatWindow\b/g) ?? []).length, 1);
  assert.match(chatSource, /onInitialPromptConsumed\?\.\(\);\s*void handleSend\(initialPrompt\)/);
  assert.match(chatSource, /role=\{quoteInputOpen \? "dialog" : "toolbar"\}/);
});

test("keeps the selection toolbar above the session sidebar", async () => {
  const chatSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

  const toolbar = chatSource.match(/role=\{quoteInputOpen \? "dialog" : "toolbar"\}[\s\S]*?zIndex:\s*(\d+)/);
  const sidebar = shellSource.match(/id="session-sidebar"[\s\S]*?zIndex:\s*(\d+)/);

  assert.ok(toolbar, "expected quote toolbar z-index");
  assert.ok(sidebar, "expected session sidebar z-index");
  assert.ok(
    Number(toolbar[1]) > Number(sidebar[1]),
    `quote toolbar z-index ${toolbar[1]} should be above session sidebar z-index ${sidebar[1]}`,
  );
});
