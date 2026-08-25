"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getFileIcon } from "./FileIcons";
import { getRelativeFilePath } from "@/lib/file-paths";
import type { GitFileStatus, GitStatusResponse } from "@/lib/git-types";

interface Props {
  cwd: string;
  selectedFilePath?: string | null;
  refreshKey?: number;
  onOpenFile: (filePath: string, fileName: string, options?: { modeHint?: "diff" }) => void;
}

const STATUS_LABELS: Record<GitFileStatus["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflict: "C",
};

const STATUS_COLORS: Record<GitFileStatus["status"], string> = {
  modified: "var(--warning)",
  added: "var(--success)",
  deleted: "var(--danger)",
  renamed: "var(--accent)",
  untracked: "var(--success)",
  conflict: "var(--danger)",
};

export function DiffPanel({ cwd, selectedFilePath, refreshKey = 0, onOpenFile }: Props) {
  const { t } = useI18n();
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`, { signal });
      const data = await response.json() as GitStatusResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setStatus(data);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setStatus(null);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);
    return () => controller.abort();
  }, [loadStatus, refreshKey]);

  const files = status?.files ?? [];

  return (
    <div className="context-diff-panel">
      <div className="context-diff-header">
        <div>
          <strong>{t("contextPanel.tabDiff")}</strong>
          <span>{status ? t("files.changeStats", { count: files.length, additions: status.additions, deletions: status.deletions }) : t("contextPanel.diffHint")}</span>
        </div>
        <button type="button" className="context-diff-refresh" onClick={() => void loadStatus()} disabled={loading} title={t("contextPanel.diffRefresh")} aria-label={t("contextPanel.diffRefresh")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0 2 5.3" />
            <path d="M20 4v7h-7" />
          </svg>
        </button>
      </div>
      {loading && <div className="context-diff-status">{t("files.loading")}</div>}
      {!loading && error && <div className="context-diff-status is-error" role="alert">{error}</div>}
      {!loading && !error && files.length === 0 && (
        <div className="context-diff-status">{t("contextPanel.diffEmpty")}</div>
      )}
      {!loading && !error && files.length > 0 && (
        <div className="context-diff-list" role="listbox" aria-label={t("contextPanel.tabDiff")}>
          {files.map((file) => {
            const selected = file.filePath === selectedFilePath;
            const fileName = file.filePath.split(/[\\/]/).pop() ?? file.filePath;
            return (
              <button
                key={`${file.filePath}:${file.status}`}
                type="button"
                className={`context-diff-row${selected ? " is-selected" : ""}`}
                onClick={() => onOpenFile(file.filePath, fileName, { modeHint: "diff" })}
                title={file.filePath}
              >
                <span className="context-diff-status-code" style={{ color: STATUS_COLORS[file.status] }}>{STATUS_LABELS[file.status]}</span>
                <span className="context-diff-file-icon">{getFileIcon(fileName, 14)}</span>
                <span className="context-diff-file-path">{getRelativeFilePath(file.filePath, cwd)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
