"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatAttachmentSize } from "@/lib/chat-attachments";
import { revealItemInDirNative } from "@/lib/desktop-native";
import { isTauriDesktop } from "@/lib/desktop-updater";

export interface SavedFileInfo {
  path: string;
  name: string;
  size: number;
}

export function isSavedFileInfo(value: unknown): value is SavedFileInfo {
  if (!value || typeof value !== "object") return false;
  const details = value as Partial<SavedFileInfo>;
  return typeof details.path === "string" && typeof details.name === "string" && typeof details.size === "number";
}

/** What `save_to_downloads` produced: the file's name, where it went, and a way to show it. */
export function SavedFileCard({ file }: { file: SavedFileInfo }) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);

  const reveal = async () => {
    setError(null);
    try {
      if (isTauriDesktop()) {
        await revealItemInDirNative(file.path);
        return;
      }
      const res = await fetch("/api/chat-downloads/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: file.path }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="saved-file-card">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      <div className="saved-file-card-text">
        <span className="saved-file-card-name">{file.name}</span>
        <span className="saved-file-card-path" title={file.path}>
          {t("chat.savedToDownloads", { size: formatAttachmentSize(file.size) })}
        </span>
        {error && <span className="saved-file-card-error" role="alert">{error}</span>}
      </div>
      <button type="button" className="saved-file-card-reveal" onClick={() => void reveal()}>
        {t("chat.revealSavedFile")}
      </button>
    </div>
  );
}
