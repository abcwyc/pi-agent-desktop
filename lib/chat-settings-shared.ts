/**
 * The shape and limits of the chat preferences, free of any server import so the
 * Settings panel (a client component) can use them.
 */
export const CHAT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ChatThinkingLevel = typeof CHAT_THINKING_LEVELS[number];

export const CHAT_INSTRUCTIONS_MAX_CHARS = 8000;

export interface ChatSettings {
  model: { provider: string; modelId: string } | null;
  thinkingLevel: ChatThinkingLevel | null;
  instructions: string;
}

export const EMPTY_CHAT_SETTINGS: ChatSettings = { model: null, thinkingLevel: null, instructions: "" };
