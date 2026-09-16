import { getFileLanguage } from "./file-language";

export interface WrittenFile {
  path: string;
  content: string;
}

export function isWriteToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "write" || name.startsWith("write_") || name.endsWith(".write") || name.endsWith("_write");
}

export function getWrittenFile(toolName: string, input: Record<string, unknown>): WrittenFile | null {
  if (!isWriteToolName(toolName)) return null;
  const path = typeof input.path === "string"
    ? input.path
    : typeof input.filePath === "string" ? input.filePath : null;
  if (!path || typeof input.content !== "string") return null;
  return { path, content: input.content };
}

export function sourceLanguageFromPath(filePath: string): string {
  const language = getFileLanguage(filePath);
  return language === "text" ? "plaintext" : language;
}
