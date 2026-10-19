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
  assert.deepEqual(readChatSettings(await settingsFile()), { model: null, thinkingLevel: null, instructions: "", allowedTools: [] });
  assert.deepEqual(parseChatSettings({ model: { provider: "p" }, thinkingLevel: "loud", instructions: 4 }), {
    model: null,
    thinkingLevel: null,
    instructions: "",
    allowedTools: [],
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
  assert.deepEqual(second, { model: { provider: "p", modelId: "m" }, thinkingLevel: "low", instructions: "Answer in Chinese.", allowedTools: [] });
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stored.artifactsPrompt, false);
  // null clears one field; blank instructions drop out of the file.
  const cleared = writeChatSettings({ model: null, instructions: "  " }, file);
  assert.deepEqual(cleared, { model: null, thinkingLevel: "low", instructions: "", allowedTools: [] });
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
  const settings = { model: { provider: "p", modelId: "m" }, thinkingLevel: "medium", instructions: "", allowedTools: [] };
  assert.deepEqual(resolveChatStartDefaults(settings, [{ provider: "p", id: "m" }]), {
    requestedModel: { provider: "p", modelId: "m" },
    thinkingLevel: "medium",
  });
  assert.deepEqual(resolveChatStartDefaults(settings, [{ provider: "p", id: "other" }]), { thinkingLevel: "medium" });
  // Unset means: follow the global default, including a saved reasoning level.
  assert.deepEqual(resolveChatStartDefaults({ model: null, thinkingLevel: null, instructions: "", allowedTools: [] }, []), {});
});

test("instructions become a prompt section only when written", () => {
  assert.equal(chatInstructionsSection({ model: null, thinkingLevel: null, instructions: " \n" }), undefined);
  assert.match(chatInstructionsSection({ model: null, thinkingLevel: null, instructions: "Be brief." }), /Be brief\.$/);
});

test("the extra-tool list is validated, deduplicated and stored only when used", async () => {
  const { parseToolNameList } = await jiti.import("./chat-settings-shared.ts");
  assert.deepEqual(parseToolNameList("web_search\nfetch_content, web_search  \n"), ["web_search", "fetch_content"]);
  assert.deepEqual(validateChatSettingsPatch({ allowedTools: ["a", "a", "b.c"] }), { allowedTools: ["a", "b.c"] });
  assert.throws(() => validateChatSettingsPatch({ allowedTools: ["bad name"] }), /not a valid tool name/);
  assert.throws(() => validateChatSettingsPatch({ allowedTools: "web_search" }), /array/);
  assert.throws(() => validateChatSettingsPatch({ allowedTools: Array.from({ length: 51 }, (_, i) => `t${i}`) }), /at most/);

  const file = await settingsFile();
  assert.deepEqual(writeChatSettings({ allowedTools: ["web_search"] }, file).allowedTools, ["web_search"]);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).chats, { allowedTools: ["web_search"] });
  assert.deepEqual(writeChatSettings({ allowedTools: [] }, file).allowedTools, []);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).chats, {});
  // A hand-edited file cannot smuggle in an odd name.
  assert.deepEqual(parseChatSettings({ allowedTools: ["ok", "has space", 4] }).allowedTools, ["ok"]);
});
