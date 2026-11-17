import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { composeMessageWithAttachedFiles, splitAttachedFiles } = await jiti.import("../lib/chat-attachments.ts");
const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const start = source.indexOf("  const handleSend = useCallback(");
const end = source.indexOf("    const promptRunId =", start);
assert.ok(start >= 0 && end > start);
// Execute the actual send-admission prefix, stopping before network/model work.
// This includes the shell branch, not a copy of the classifier under test.
const prefix = source.slice(start, end);
const js = ts.transpileModule(`${prefix}
  return { route: "prompt", message, images, isSlashCommandPrompt };
}); return handleSend;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(chatWorkspace = false) {
  const shell = [], restored = [], notices = [];
  const env = {
    useCallback: (fn) => fn,
    agentRunningRef: { current: false }, bashRunningRef: { current: false },
    branchSummaryHolds: () => false, branchSummarySessionIdRef: { current: null },
    sessionIdRef: { current: "session" }, editEntryId: null,
    restoreSubmission: (...args) => restored.push(args), composerDraftKey: "draft",
    splitAttachedFiles, chatWorkspace, addNotice: (notice) => notices.push(notice), t: (key) => key,
    executeBashRef: { current: async (...args) => shell.push(args) },
  };
  const send = new Function(...Object.keys(env), js)(...Object.values(env));
  return { send, shell, restored, notices };
}

test("text attachments keep ! and !! prompts out of the shell in projects and chats", async () => {
  for (const chatWorkspace of [false, true]) {
    for (const text of ["!echo test", "!!echo test", "/session", ""]) {
      const h = harness(chatWorkspace);
      const message = composeMessageWithAttachedFiles(text, [{ name: "Pasted text.txt", text: "payload\n!echo must-not-run" }]);
      const result = await h.send(message);
      assert.equal(result.route, "prompt");
      assert.equal(result.message, message, "model must receive the unmodified attachment payload");
      assert.equal(result.isSlashCommandPrompt, false);
      assert.deepEqual(h.shell, []);
      assert.deepEqual(h.restored, []);
      assert.deepEqual(h.notices, []);
    }
  }
});

test("plain shell, excluded shell and slash behavior is preserved without attachments", async () => {
  const h = harness();
  await h.send("!echo test");
  await h.send("!!echo hidden");
  assert.deepEqual(h.shell, [["echo test", false], ["echo hidden", true]]);
  assert.equal((await h.send("/session")).isSlashCommandPrompt, true);
  const chat = harness(true);
  await chat.send("!echo test");
  assert.deepEqual(chat.shell, []);
  assert.equal(chat.notices[0].message, "chat.chatOnlyNoShell");
});

test("image attachments and malformed attachment markers retain existing admission", async () => {
  const h = harness();
  const images = [{ data: "aGVsbG8=", mimeType: "image/png" }];
  const result = await h.send("!describe", images);
  assert.equal(result.route, "prompt");
  assert.equal(result.images, images);
  assert.deepEqual(h.shell, []);
  await h.send('!echo literal <attached_file name="not-closed.txt">');
  assert.equal(h.shell.length, 1, "an incomplete marker is not a real attachment");
});
