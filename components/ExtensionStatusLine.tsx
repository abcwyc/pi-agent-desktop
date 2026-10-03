"use client";

import { stripAnsi } from "@/lib/ansi";
import type { ExtensionStatusItem } from "@/lib/types";
import { AnsiText } from "./AnsiText";

/**
 * Joins `ctx.ui.setStatus` entries into one footer line, ordered by key like
 * pi's TUI footer. Each text is collapsed to a single line: the row is a
 * one-line strip under the composer, and the full text stays in the tooltip.
 */
export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  return [...statuses]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ text }) => text.replace(/\s+/g, " ").trim())
    .filter((text) => stripAnsi(text).trim().length > 0)
    .join("  ");
}

export function ExtensionStatusLine({ statuses }: { statuses: ExtensionStatusItem[] }) {
  const line = formatExtensionStatusLine(statuses);
  if (!line) return null;
  const plain = stripAnsi(line);
  return (
    <div role="status" className="extension-status-line" aria-label={plain} title={plain}>
      <span className="extension-status-text">
        <AnsiText text={line} />
      </span>
    </div>
  );
}
