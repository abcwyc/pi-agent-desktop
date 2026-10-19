import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { deriveSessionPolicy } = await jiti.import("./session-policy.ts");

test("a chat loads extensions but never reaches files or a shell, and has no tool preset", () => {
  assert.deepEqual(deriveSessionPolicy({ chatWorkspace: true }), {
    kind: "chat",
    reachesFilesAndShell: false,
    loadsExtensions: true,
    allowsToolPresets: false,
    sendsExactPrompt: false,
  });
  // The hidden workspace wins over a stale chat-only selection recorded in an old transcript.
  assert.equal(deriveSessionPolicy({ chatWorkspace: true, chatOnly: true }).kind, "chat");
});

test("a chat-only project session loads nothing and sends an exact prompt", () => {
  const policy = deriveSessionPolicy({ chatOnly: true });
  assert.equal(policy.kind, "chat-only");
  assert.equal(policy.loadsExtensions, false);
  assert.equal(policy.sendsExactPrompt, true);
  assert.equal(policy.allowsToolPresets, true);
});

test("everything else is a project session", () => {
  assert.deepEqual(deriveSessionPolicy({}), {
    kind: "project",
    reachesFilesAndShell: true,
    loadsExtensions: true,
    allowsToolPresets: true,
    sendsExactPrompt: false,
  });
});
