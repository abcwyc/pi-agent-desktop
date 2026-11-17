import type { AgentMessage, UserMessage } from "./types";
import type { ChatDraftImage } from "./draft-store";
import { MAX_ATTACHED_IMAGES, isBase64ImageWithinLimits } from "./image-attachments";
import { userImageDisplayText } from "./user-image-display";

/** One composer-history row: the user's own text, without SDK transport notes,
 * plus the images that were attached to it. */
export interface ComposerHistoryEntry {
  text: string;
  images: ChatDraftImage[];
}

const MAX_HISTORY_ENTRIES = 50;

function historyImages(message: UserMessage): ChatDraftImage[] {
  if (typeof message.content === "string") return [];
  return message.content.flatMap((block) => {
    if (block.type !== "image") return [];
    // Current nested format plus the older flat pi-ai entries.
    const flat = block as unknown as { data?: unknown; mimeType?: unknown };
    const data = block.source?.type === "base64" ? block.source.data : flat.data;
    const mimeType = block.source?.type === "base64" ? block.source.media_type : flat.mimeType;
    if (typeof data !== "string" || typeof mimeType !== "string") return [];
    const image = { data, mimeType };
    return isBase64ImageWithinLimits(image) ? [image] : [];
  }).slice(0, MAX_ATTACHED_IMAGES);
}

function historyText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Build the ↑/history menu from the transcript, newest last.
 *
 * Reuses the same projection as the message bubble so an SDK image resize note
 * never comes back as typed text, and keeps the prompt's images so selecting an
 * earlier image question restores its attachments instead of dropping them.
 * Entries without text survive when they carried images (an image-only prompt);
 * identical prompts are listed once.
 */
export function buildComposerHistory(messages: AgentMessage[], limit = MAX_HISTORY_ENTRIES): ComposerHistoryEntry[] {
  const seen = new Set<string>();
  const history: ComposerHistoryEntry[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const images = historyImages(message as UserMessage);
    const text = userImageDisplayText(historyText(message as UserMessage), images.length).trim();
    if (!text && images.length === 0) continue;
    // Text alone identifies ordinary prompts. An image-only prompt has no text,
    // so its first image payload distinguishes it from another image-only one.
    const key = `${text}\u0000${images.length ? images[0].data.slice(0, 64) : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    history.push({ text, images });
    if (history.length >= limit) break;
  }
  return history.reverse();
}
