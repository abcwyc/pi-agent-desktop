// What the user asked in each session and when, for the Tasks page calendar.
// The session list keeps only the first message; the calendar needs every
// user prompt with its time, so it can put each session on every day it was
// used and title that day by its first question. Read on demand for the
// sessions active in the visible range, and cached by file fingerprint.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { attachmentAwareTitle } from "./chat-attachments";
import { extractTextContent } from "./session-list-scanner";
import { sessionListFirstMessage } from "./slash-display";
import { userImageDisplayText, userMessageImageCount } from "./user-image-display";
import type { SessionPrompt } from "./calendar-types";

const PROMPT_CHARS = 300;
const REPLY_CHARS = 400;
const MAX_CONCURRENT_SCANS = 8;

interface CacheEntry {
  size: number;
  mtimeMs: number;
  prompts: SessionPrompt[];
}

declare global {
  var __piSessionPromptCache: Map<string, CacheEntry> | undefined;
}

type RawEntry = Record<string, unknown>;

function cache(): Map<string, CacheEntry> {
  globalThis.__piSessionPromptCache ??= new Map();
  return globalThis.__piSessionPromptCache;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${Array.from(flat.slice(0, max * 2)).slice(0, max).join("")}…`;
}

function timeOf(entry: RawEntry, message: RawEntry): number | null {
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
  const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Every user prompt in a session file, oldest first, each with the last text
 * reply that descends from it. All branches count: a prompt on an abandoned
 * branch was still asked that day. A reply is matched to its prompt through
 * `parentId`, so a reply on one branch never lands on another branch's prompt.
 */
export async function scanSessionPrompts(filePath: string): Promise<SessionPrompt[]> {
  const prompts: SessionPrompt[] = [];
  const byId = new Map<string, SessionPrompt>();
  // Entry id -> id of the nearest user prompt at or above it.
  const promptOf = new Map<string, string | null>();
  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  let header = true;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: RawEntry;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entry = parsed as RawEntry;
    } catch {
      continue;
    }
    if (header) {
      header = false;
      if (entry.type !== "session") return [];
      continue;
    }
    if (typeof entry.id !== "string") continue;
    const parentPrompt = typeof entry.parentId === "string" ? promptOf.get(entry.parentId) ?? null : null;
    const message = entry.type === "message" ? entry.message as RawEntry | undefined : undefined;
    if (!message || typeof message !== "object" || (message.role !== "user" && message.role !== "assistant")) {
      promptOf.set(entry.id, parentPrompt);
      continue;
    }
    const text = extractTextContent(message);
    if (message.role === "assistant") {
      promptOf.set(entry.id, parentPrompt);
      const prompt = parentPrompt ? byId.get(parentPrompt) : undefined;
      if (prompt && text.trim()) prompt.reply = clip(text, REPLY_CHARS);
      continue;
    }
    const at = timeOf(entry, message);
    if (!text || at === null) {
      promptOf.set(entry.id, parentPrompt);
      continue;
    }
    const display = sessionListFirstMessage(attachmentAwareTitle(
      userImageDisplayText(text, userMessageImageCount(message.content)),
    ));
    const prompt: SessionPrompt = { at, entryId: entry.id, text: clip(display, PROMPT_CHARS) };
    prompts.push(prompt);
    byId.set(entry.id, prompt);
    promptOf.set(entry.id, entry.id);
  }
  return prompts.sort((a, b) => a.at - b.at);
}

async function cachedPrompts(filePath: string): Promise<SessionPrompt[]> {
  let fingerprint: { size: number; mtimeMs: number };
  try {
    const s = await stat(filePath);
    fingerprint = { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    cache().delete(filePath);
    return [];
  }
  const hit = cache().get(filePath);
  if (hit && hit.size === fingerprint.size && hit.mtimeMs === fingerprint.mtimeMs) return hit.prompts;
  const prompts = await scanSessionPrompts(filePath).catch(() => []);
  cache().set(filePath, { ...fingerprint, prompts });
  return prompts;
}

export interface PromptSource {
  id: string;
  path: string;
  created: string;
  modified: string;
}

/**
 * Prompts asked in [from, to) for each session that was active then. A
 * session's prompts all fall between its creation and its last activity, so
 * sessions outside the range are skipped without being read.
 */
export async function collectSessionPrompts(
  sessions: PromptSource[],
  from: number,
  to: number,
): Promise<Record<string, SessionPrompt[]>> {
  const candidates = sessions.filter((session) => {
    const created = Date.parse(session.created);
    const modified = Date.parse(session.modified);
    return !(created >= to) && !(modified < from);
  });
  const result: Record<string, SessionPrompt[]> = {};
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const session = candidates[next++];
      const inRange = (await cachedPrompts(session.path)).filter((prompt) => prompt.at >= from && prompt.at < to);
      if (inRange.length > 0) result[session.id] = inRange;
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_SCANS, candidates.length) }, worker));
  // Files deleted since are dropped from the cache so it does not grow forever.
  const known = new Set(sessions.map((session) => session.path));
  for (const path of cache().keys()) if (!known.has(path)) cache().delete(path);
  return result;
}
