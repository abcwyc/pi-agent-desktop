/**
 * Text files attached to a chat message.
 *
 * A chat has no file tools, so an attached file travels inside the message itself: the
 * composer reads it in the browser and appends it as an `<attached_file>` block, and the
 * transcript renders that block as a chip instead of a wall of text. The model sees the
 * block as ordinary message text.
 */

export const CHAT_ATTACHMENT_MAX_FILE_BYTES = 256 * 1024;
export const CHAT_ATTACHMENT_MAX_TOTAL_BYTES = 512 * 1024;
export const CHAT_ATTACHMENT_MAX_FILES = 5;

export interface ChatTextAttachment {
  id: string;
  name: string;
  size: number;
  text: string;
}

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "mdx", "rst", "log", "csv", "tsv", "json", "jsonl", "ndjson",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "xml", "html", "htm", "svg", "css",
  "scss", "less", "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "sql", "graphql", "gql", "proto", "lua", "r",
  "dart", "scala", "tex", "diff", "patch", "gitignore", "dockerfile", "makefile", "lock",
]);

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-sh",
  "application/x-yaml",
  "application/toml",
  "image/svg+xml",
]);

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return (dot < 0 ? base : base.slice(dot + 1)).toLowerCase();
}

/** Whether a file is plain text the composer can inline (code, notes, data). */
export function isChatTextAttachment(file: { name: string; type?: string }): boolean {
  if (file.type?.startsWith("image/") && file.type !== "image/svg+xml") return false;
  if (file.type?.startsWith("text/") || (file.type && TEXT_MIME_TYPES.has(file.type))) return true;
  return TEXT_EXTENSIONS.has(extensionOf(file.name));
}

export type ChatAttachmentRejection =
  | { name: string; reason: "unsupported" }
  | { name: string; reason: "too-large"; limit: number }
  | { name: string; reason: "not-text" }
  | { name: string; reason: "too-many"; limit: number }
  | { name: string; reason: "total-too-large"; limit: number };

export interface ChatAttachmentReadResult {
  accepted: ChatTextAttachment[];
  rejected: ChatAttachmentRejection[];
}

/**
 * Read picked files as UTF-8 text, within the per-file, per-message and count limits.
 * `existing` is what the composer already holds, so the limits cover the whole message.
 */
export async function readChatTextAttachments(
  files: readonly File[],
  existing: readonly ChatTextAttachment[] = [],
): Promise<ChatAttachmentReadResult> {
  const accepted: ChatTextAttachment[] = [];
  const rejected: ChatAttachmentRejection[] = [];
  let count = existing.length;
  let totalBytes = existing.reduce((sum, file) => sum + file.size, 0);

  for (const file of files) {
    if (!isChatTextAttachment(file)) {
      rejected.push({ name: file.name, reason: "unsupported" });
      continue;
    }
    if (count >= CHAT_ATTACHMENT_MAX_FILES) {
      rejected.push({ name: file.name, reason: "too-many", limit: CHAT_ATTACHMENT_MAX_FILES });
      continue;
    }
    if (file.size > CHAT_ATTACHMENT_MAX_FILE_BYTES) {
      rejected.push({ name: file.name, reason: "too-large", limit: CHAT_ATTACHMENT_MAX_FILE_BYTES });
      continue;
    }
    if (totalBytes + file.size > CHAT_ATTACHMENT_MAX_TOTAL_BYTES) {
      rejected.push({ name: file.name, reason: "total-too-large", limit: CHAT_ATTACHMENT_MAX_TOTAL_BYTES });
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      rejected.push({ name: file.name, reason: "not-text" });
      continue;
    }
    if (text.includes("\0")) {
      rejected.push({ name: file.name, reason: "not-text" });
      continue;
    }
    count += 1;
    totalBytes += file.size;
    accepted.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      size: file.size,
      text: text.replace(/^﻿/, ""),
    });
  }
  return { accepted, rejected };
}

const OPEN_TAG = /<attached_file name="([^"]*)">\n/;
const CLOSE_TAG = "\n</attached_file>";

function escapeName(name: string): string {
  return name.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/[\r\n]+/g, " ");
}

function unescapeName(name: string): string {
  return name.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** The block one attached file becomes inside a message. */
export function formatAttachedFileBlock(file: { name: string; text: string }): string {
  // A file that contains the closing tag must not end its own block early.
  const body = file.text.replace(/<\/attached_file>/g, "<\\/attached_file>");
  return `<attached_file name="${escapeName(file.name)}">\n${body}${CLOSE_TAG}`;
}

/** The message text with every attached file appended after what the user typed. */
export function composeMessageWithAttachedFiles(
  text: string,
  files: readonly { name: string; text: string }[],
): string {
  if (files.length === 0) return text;
  const blocks = files.map(formatAttachedFileBlock).join("\n\n");
  return text ? `${text}\n\n${blocks}` : blocks;
}

export interface SplitAttachedFiles {
  text: string;
  files: { name: string; text: string }[];
}

/** Separate the attached-file blocks from the text around them (the reverse of compose). */
export function splitAttachedFiles(content: string): SplitAttachedFiles {
  if (!content.includes("<attached_file name=")) return { text: content, files: [] };
  const files: { name: string; text: string }[] = [];
  let rest = content;
  let text = "";
  for (;;) {
    const open = OPEN_TAG.exec(rest);
    if (!open) {
      text += rest;
      break;
    }
    const bodyStart = open.index + open[0].length;
    const close = rest.indexOf(CLOSE_TAG, bodyStart);
    if (close < 0) {
      text += rest;
      break;
    }
    text += rest.slice(0, open.index);
    files.push({
      name: unescapeName(open[1] ?? ""),
      text: rest.slice(bodyStart, close).replace(/<\\\/attached_file>/g, "</attached_file>"),
    });
    rest = rest.slice(close + CLOSE_TAG.length);
  }
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), files };
}

/** A short label for a session list or tab: the typed text, else the file names. */
export function attachmentAwareTitle(content: string): string {
  const { text, files } = splitAttachedFiles(content);
  if (text) return text;
  return files.map((file) => file.name).join(", ");
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
