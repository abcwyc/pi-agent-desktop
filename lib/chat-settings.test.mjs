import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  CHAT_INSTRUCTIONS_MAX_CHARS,
  chatInstructionsSection,
  parseChatSettings,
  readChatSettings,
  resolveChatStartDefaults,
  validateChatSettingsPatch,
  writeChatSettings,
} = await jiti.import("./chat-settings.ts");

async function settingsFile(initial) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-chat-settings-"));
  const file = path.join(dir, "settings.json");
  if (initial !== undefined) await writeFile(file, JSON.stringify(initial));
  return file;
}

test("nothing is set by default, and a malformed block reads as not set", async () => {
  assert.deepEqual(readChatSettings(await settingsFile()), { model: null, thinkingLevel: null, instructions: "" });
  assert.deepEqual(parseChatSettings({ model: { provider: "p" }, thinkingLevel: "loud", instructions: 4 }), {
    model: null,
    thinkingLevel: null,
    instructions: "",
  });
  // An unreadable file must not break a session start.
  const broken = await settingsFile();
  await writeFile(broken, "{not json");
  assert.equal(readChatSettings(broken).model, null);
});

test("writes merge into the chats block and keep the other Pi Web settings", async () => {
  const file = await settingsFile({ version: 1, artifactsPrompt: false });
  writeChatSettings({ model: { provider: "p", modelId: "m" }, thinkingLevel: "low" }, file);
  const second = writeChatSettings({ instructions: "Answer in Chinese." }, file);
  assert.deepEqual(second, { model: { provider: "p", modelId: "m" }, thinkingLevel: "low", instructions: "Answer in Chinese." });
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stored.artifactsPrompt, false);
  // null clears one field; blank instructions drop out of the file.
  const cleared = writeChatSettings({ model: null, instructions: "  " }, file);
  assert.deepEqual(cleared, { model: null, thinkingLevel: "low", instructions: "" });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).chats, { thinkingLevel: "low" });
});

test("a patch is validated before anything is written", () => {
  assert.deepEqual(validateChatSettingsPatch({ model: null, thinkingLevel: "max" }), { model: null, thinkingLevel: "max" });
  assert.throws(() => validateChatSettingsPatch({ model: { provider: "p" } }), /model must be/);
  assert.throws(() => validateChatSettingsPatch({ thinkingLevel: "turbo" }), /thinkingLevel/);
  assert.throws(() => validateChatSettingsPatch({ instructions: "x".repeat(CHAT_INSTRUCTIONS_MAX_CHARS + 1) }), /limited to/);
  assert.throws(() => validateChatSettingsPatch([]), /object/);
});

test("new chats take the chosen model only while it is still enabled", () => {
  const settings = { model: { provider: "p", modelId: "m" }, thinkingLevel: "medium", instructions: "" };
  assert.deepEqual(resolveChatStartDefaults(settings, [{ provider: "p", id: "m" }]), {
    requestedModel: { provider: "p", modelId: "m" },
    thinkingLevel: "medium",
  });
  assert.deepEqual(resolveChatStartDefaults(settings, [{ provider: "p", id: "other" }]), { thinkingLevel: "medium" });
  // Unset means: follow the global default, including a saved reasoning level.
  assert.deepEqual(resolveChatStartDefaults({ model: null, thinkingLevel: null, instructions: "" }, []), {});
});

test("instructions become a prompt section only when written", () => {
  assert.equal(chatInstructionsSection({ model: null, thinkingLevel: null, instructions: " \n" }), undefined);
  assert.match(chatInstructionsSection({ model: null, thinkingLevel: null, instructions: "Be brief." }), /Be brief\.$/);
});
