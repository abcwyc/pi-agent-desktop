/**
 * The shape and limits of the chat preferences, free of any server import so the
 * Settings panel (a client component) can use them.
 */
export const CHAT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ChatThinkingLevel = typeof CHAT_THINKING_LEVELS[number];

export const CHAT_INSTRUCTIONS_MAX_CHARS = 8000;

/** Extension tools the user lets a chat use on top of read, codemode, tool_search and MCP. */
export const CHAT_ALLOWED_TOOLS_MAX = 50;
export const CHAT_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Split free text (one tool name per line, or commas) into a clean, unique name list. */
export function parseToolNameList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((name) => name.trim()).filter(Boolean))];
}

export interface ChatSettings {
  model: { provider: string; modelId: string } | null;
  thinkingLevel: ChatThinkingLevel | null;
  instructions: string;
  allowedTools: string[];
}

export const EMPTY_CHAT_SETTINGS: ChatSettings = { model: null, thinkingLevel: null, instructions: "", allowedTools: [] };
