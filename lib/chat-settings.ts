import { getPiWebSettingsPath, readStored, updatePiWebSettings } from "./artifact-settings";
import {
  CHAT_ALLOWED_TOOLS_MAX,
  CHAT_INSTRUCTIONS_MAX_CHARS,
  CHAT_THINKING_LEVELS,
  CHAT_TOOL_NAME_PATTERN,
  EMPTY_CHAT_SETTINGS,
  type ChatSettings,
  type ChatThinkingLevel,
} from "./chat-settings-shared";

/**
 * Preferences that apply to chats only (the hidden non-project workspace), kept in Pi
 * Web's own settings file under `chats`. Every field is optional: unset means "follow the
 * global default", so the reasoning level the user saved as their default is never
 * overridden by this block.
 */
export {
  CHAT_ALLOWED_TOOLS_MAX,
  CHAT_INSTRUCTIONS_MAX_CHARS,
  CHAT_THINKING_LEVELS,
  EMPTY_CHAT_SETTINGS,
  type ChatSettings,
  type ChatThinkingLevel,
} from "./chat-settings-shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tolerant parse of the stored block: anything malformed reads as "not set". */
export function parseChatSettings(raw: unknown): ChatSettings {
  if (!isRecord(raw)) return { ...EMPTY_CHAT_SETTINGS };
  const model = isRecord(raw.model)
    && typeof raw.model.provider === "string" && raw.model.provider
    && typeof raw.model.modelId === "string" && raw.model.modelId
    ? { provider: raw.model.provider, modelId: raw.model.modelId }
    : null;
  const thinkingLevel = (CHAT_THINKING_LEVELS as readonly unknown[]).includes(raw.thinkingLevel)
    ? raw.thinkingLevel as ChatThinkingLevel
    : null;
  const instructions = typeof raw.instructions === "string"
    ? raw.instructions.slice(0, CHAT_INSTRUCTIONS_MAX_CHARS)
    : "";
  const allowedTools = Array.isArray(raw.allowedTools)
    ? [...new Set(raw.allowedTools.filter((name): name is string => (
      typeof name === "string" && CHAT_TOOL_NAME_PATTERN.test(name)
    )))].slice(0, CHAT_ALLOWED_TOOLS_MAX)
    : [];
  return { model, thinkingLevel, instructions, allowedTools, confirmSave: raw.confirmSave === true };
}

/** The chat preferences; an unreadable file reads as "not set" rather than failing a session start. */
export function readChatSettings(settingsPath = getPiWebSettingsPath()): ChatSettings {
  try {
    return parseChatSettings(readStored(settingsPath).chats);
  } catch {
    return { ...EMPTY_CHAT_SETTINGS };
  }
}

export type ChatSettingsPatch = {
  model?: ChatSettings["model"];
  thinkingLevel?: ChatSettings["thinkingLevel"];
  instructions?: string;
  allowedTools?: string[];
  confirmSave?: boolean;
};

/** Validate a client patch; throws a message for the first invalid field. */
export function validateChatSettingsPatch(body: unknown): ChatSettingsPatch {
  if (!isRecord(body)) throw new Error("Expected an object");
  const patch: ChatSettingsPatch = {};
  if ("model" in body) {
    if (body.model === null) patch.model = null;
    else if (
      isRecord(body.model)
      && typeof body.model.provider === "string" && body.model.provider
      && typeof body.model.modelId === "string" && body.model.modelId
    ) patch.model = { provider: body.model.provider, modelId: body.model.modelId };
    else throw new Error("model must be null or { provider, modelId }");
  }
  if ("thinkingLevel" in body) {
    if (body.thinkingLevel === null) patch.thinkingLevel = null;
    else if ((CHAT_THINKING_LEVELS as readonly unknown[]).includes(body.thinkingLevel)) {
      patch.thinkingLevel = body.thinkingLevel as ChatThinkingLevel;
    } else throw new Error("thinkingLevel must be null or a reasoning level");
  }
  if ("instructions" in body) {
    if (typeof body.instructions !== "string") throw new Error("instructions must be a string");
    if (body.instructions.length > CHAT_INSTRUCTIONS_MAX_CHARS) {
      throw new Error(`instructions are limited to ${CHAT_INSTRUCTIONS_MAX_CHARS} characters`);
    }
    patch.instructions = body.instructions;
  }
  if ("allowedTools" in body) {
    if (!Array.isArray(body.allowedTools) || body.allowedTools.some((name) => typeof name !== "string")) {
      throw new Error("allowedTools must be an array of tool names");
    }
    const names = [...new Set(body.allowedTools as string[])];
    const invalid = names.find((name) => !CHAT_TOOL_NAME_PATTERN.test(name));
    if (invalid !== undefined) throw new Error(`"${invalid}" is not a valid tool name`);
    if (names.length > CHAT_ALLOWED_TOOLS_MAX) throw new Error(`at most ${CHAT_ALLOWED_TOOLS_MAX} tools can be allowed`);
    patch.allowedTools = names;
  }
  if ("confirmSave" in body) {
    if (typeof body.confirmSave !== "boolean") throw new Error("confirmSave must be true or false");
    patch.confirmSave = body.confirmSave;
  }
  return patch;
}

export function writeChatSettings(patch: ChatSettingsPatch, settingsPath = getPiWebSettingsPath()): ChatSettings {
  const next = { ...readChatSettings(settingsPath), ...patch };
  updatePiWebSettings({
    chats: {
      ...(next.model ? { model: next.model } : {}),
      ...(next.thinkingLevel ? { thinkingLevel: next.thinkingLevel } : {}),
      ...(next.instructions.trim() ? { instructions: next.instructions } : {}),
      ...(next.allowedTools.length > 0 ? { allowedTools: next.allowedTools } : {}),
      ...(next.confirmSave ? { confirmSave: true } : {}),
    },
  }, settingsPath);
  return readChatSettings(settingsPath);
}

/**
 * What a brand-new chat starts with beyond the global defaults. The chosen model counts
 * only while it is still in the enabled scope, so a removed model falls back to the
 * global default instead of failing the start.
 */
export function resolveChatStartDefaults(
  settings: ChatSettings,
  visibleModels: readonly { provider: string; id: string }[],
): { requestedModel?: { provider: string; modelId: string }; thinkingLevel?: ChatThinkingLevel } {
  const model = settings.model;
  const available = model && visibleModels.some((candidate) => (
    candidate.provider === model.provider && candidate.id === model.modelId
  ));
  return {
    ...(available && model ? { requestedModel: model } : {}),
    ...(settings.thinkingLevel ? { thinkingLevel: settings.thinkingLevel } : {}),
  };
}

/** The `instructions` prompt section, or undefined when the user wrote none. */
export function chatInstructionsSection(settings: ChatSettings): string | undefined {
  const text = settings.instructions.trim();
  return text
    ? `The user's own instructions for every chat. Follow them unless they conflict with this prompt:\n${text}`
    : undefined;
}
