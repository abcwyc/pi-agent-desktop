"use client";

import { useEffect, useState, useRef, useCallback, useMemo, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import {
  createElement as renderSyntaxNode,
  type SyntaxHighlighterProps,
} from "react-syntax-highlighter";
import { SyntaxHighlighter, vs, vscDarkPlus } from "@/lib/syntax-highlighting";
import ReactMarkdown from "react-markdown";
import { useTheme } from "@/hooks/useTheme";
import {
  DOCX_PREVIEW_MAX_BYTES,
  getFileExt,
  isAudioPath,
  isDocumentPreviewPath,
  isImagePath,
} from "@/lib/file-types";
import { encodeFilePathForApi, getFileDirectory, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { resolveLocalFileHref } from "@/lib/file-links";
import { markdownPreviewRehypePlugins, markdownPreviewRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { CodeBlock, MermaidBlock } from "./MermaidBlock";
import { parseUnifiedPatch } from "@/lib/patch";
import type { GitFileDiffResponse } from "@/lib/git-types";
import { getFileIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  filePath: string;
  cwd?: string;
  sourceSessionId?: string | null;
  onOpenFile?: (filePath: string) => void;
  onMentionLines?: (relativePath: string, startLine: number, endLine: number) => void;
  gitRefreshKey?: number;
  initialDisplayMode?: DisplayMode;
}

interface FileData {
  content: string;
  language: string;
  size: number;
}

type DisplayMode = "source" | "preview" | "diff";

const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  source: "Source",
  preview: "Preview",
  diff: "Diff",
};

function getDefaultDisplayMode(filePath: string, initialDisplayMode?: DisplayMode): DisplayMode {
  if (initialDisplayMode === "diff") return "diff";

  const extension = getFileExt(filePath);
  if (extension === "md" || extension === "mdx" || extension === "html" || extension === "htm") {
    return "preview";
  }

  return initialDisplayMode ?? "source";
}

const FILE_CODE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  lineHeight: 1.6,
};

const FILE_LINE_NUMBER_STYLE: CSSProperties = {
  width: 48,
  minWidth: 48,
  padding: "0 10px",
  textAlign: "right",
  color: "var(--text-dim)",
  background: "var(--bg-panel)",
  borderRight: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontStyle: "normal",
  fontVariantNumeric: "tabular-nums",
  lineHeight: "20.8px",
  userSelect: "none",
  flexShrink: 0,
  verticalAlign: "top",
};

type SourceCodeRendererProps = Parameters<NonNullable<SyntaxHighlighterProps["renderer"]>>[0] & {
  wrapLines: boolean;
};

interface SelectedLineRange {
  startLine: number;
  endLine: number;
}

function MentionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

function closestSourceLine(node: Node): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  return element?.closest<HTMLElement>(".file-source-line[data-line-number]") ?? null;
}

function getSelectedSourceLineRange(root: HTMLElement, selection: Selection | null): SelectedLineRange | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

  let startElement = closestSourceLine(range.startContainer);
  let endElement = closestSourceLine(range.endContainer);
  if (!startElement || !endElement || !root.contains(startElement) || !root.contains(endElement)) return null;

  let startLine = Number(startElement.dataset.lineNumber);
  let endLine = Number(endElement.dataset.lineNumber);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;

  if (startLine < endLine) {
    // Browser ranges can start at the end of the preceding line or end at the
    // start of the following line. Exclude either boundary line when none of
    // its source text is actually selected.
    const startContent = startElement.querySelector<HTMLElement>(".file-source-line-content");
    if (startContent?.contains(range.startContainer)) {
      const selectedSuffix = document.createRange();
      selectedSuffix.selectNodeContents(startContent);
      selectedSuffix.setStart(range.startContainer, range.startOffset);
      if (selectedSuffix.toString().length === 0) {
        const nextLine = startElement.nextElementSibling;
        if (nextLine instanceof HTMLElement && nextLine.matches(".file-source-line[data-line-number]")) {
          startElement = nextLine;
          startLine = Number(startElement.dataset.lineNumber);
        }
      }
    }

    const endContent = endElement.querySelector<HTMLElement>(".file-source-line-content");
    if (endContent?.contains(range.endContainer)) {
      const selectedPrefix = document.createRange();
      selectedPrefix.selectNodeContents(endContent);
      selectedPrefix.setEnd(range.endContainer, range.endOffset);
      if (selectedPrefix.toString().length === 0) {
        const previousLine = endElement.previousElementSibling;
        if (previousLine instanceof HTMLElement && previousLine.matches(".file-source-line[data-line-number]")) {
          endElement = previousLine;
          endLine = Number(endElement.dataset.lineNumber);
        }
      }
    }
  }

  if (startLine > endLine) return null;
  return { startLine, endLine };
}

function SourceCodeRenderer({ rows, stylesheet, useInlineStyles, wrapLines }: SourceCodeRendererProps) {
  return rows.map((row, lineIndex) => {
    const children = row.children ?? [];
    const firstChildClasses = children[0]?.properties?.className;
    const hasLineNumber = Array.isArray(firstChildClasses)
      && firstChildClasses.includes("react-syntax-highlighter-line-number");
    const lineNumberNode = hasLineNumber ? children[0] : null;
    const contentNodes = hasLineNumber ? children.slice(1) : children;

    return (
      <span
        className="file-source-line"
        data-line-number={lineIndex + 1}
        key={`source-line-${lineIndex}`}
        style={{ display: "flex", minWidth: "100%" }}
      >
        {lineNumberNode && renderSyntaxNode({
          node: lineNumberNode,
          stylesheet,
          useInlineStyles,
          key: `source-line-number-${lineIndex}`,
        })}
        <span
          className="file-source-line-content"
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            overflowWrap: wrapLines ? "anywhere" : "normal",
            whiteSpace: wrapLines ? "pre-wrap" : "pre",
          }}
        >
          {contentNodes.map((node, tokenIndex) => renderSyntaxNode({
            node,
            stylesheet,
            useInlineStyles,
            key: `source-token-${lineIndex}-${tokenIndex}`,
          }))}
        </span>
      </span>
    );
  });
}

function getFileApiUrl(
  filePath: string,
  type: "read" | "download" | "meta" | "preview" | "serve" | "watch",
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
  const encoded = encodeFilePathForApi(filePath);
  const searchParams = new URLSearchParams({ type });
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return `/api/files/${encoded}?${searchParams.toString()}`;
}

function DownloadLink({ filePath, sourceSessionId }: { filePath: string; sourceSessionId?: string | null }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      title={t("i18n.downloadFile")}
      aria-label={t("i18n.downloadFile")}
      className="file-viewer-icon-button"
      onClick={() => {
        void (async () => {
          setBusy(true);
          try {
            const { saveLocalFileAs } = await import("@/lib/desktop-native");
            await saveLocalFileAs(
              filePath,
              getFileName(filePath),
              getFileApiUrl(filePath, "download", sourceSessionId),
            );
          } catch (error) {
            console.error("Failed to save file:", error);
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </button>
  );
}

function DesktopPathActions({ filePath }: { filePath: string }) {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    void import("@/lib/desktop-native").then(({ isTauriDesktop }) => {
      setDesktop(isTauriDesktop());
    });
  }, []);
  if (!desktop) return null;

  return (
    <>
      <button
        type="button"
        title="Open with default app"
        aria-label="Open with default app"
        className="file-viewer-icon-button"
        onClick={() => {
          void import("@/lib/desktop-native").then(({ openPathNative }) => openPathNative(filePath));
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </button>
      <button
        type="button"
        title="Reveal in Finder"
        aria-label="Reveal in Finder"
        className="file-viewer-icon-button"
        onClick={() => {
          void import("@/lib/desktop-native").then(({ revealItemInDirNative }) => revealItemInDirNative(filePath));
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
      </button>
    </>
  );
}

function FileViewerToolbar({
  filePath,
  cwd,
  metadata,
  watching,
  sourceSessionId,
  children,
}: {
  filePath: string;
  cwd?: string;
  metadata?: string | null;
  watching: boolean;
  sourceSessionId?: string | null;
  children?: ReactNode;
}) {
  const relativePath = getRelativeFilePath(filePath, cwd);
  return (
    <div className="file-viewer-toolbar">
      <div className="file-viewer-identity">
        <span className="file-viewer-file-icon" aria-hidden="true">
          {getFileIcon(getFileName(filePath), 15)}
        </span>
        <span className="file-viewer-path" title={filePath}>{relativePath}</span>
        {metadata && <span className="file-viewer-meta" title={metadata}>{metadata}</span>}
      </div>
      <span
        title={watching ? "Live sync active" : "Live sync unavailable"}
        aria-label={watching ? "Live sync active" : "Live sync unavailable"}
        className={`file-viewer-live-status${watching ? " is-live" : ""}`}
      >
        <span className="file-viewer-live-indicator" />
        <span>{watching ? "Live" : "Static"}</span>
      </span>
      <div className="file-viewer-controls">
        {children}
        <DesktopPathActions filePath={filePath} />
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
    </div>
  );
}

function FileViewerStatus({
  kind,
  message,
  onRetry,
}: {
  kind: "loading" | "error" | "empty";
  message?: string;
  onRetry?: () => void;
}) {
  const title = kind === "loading"
    ? "Opening file"
    : kind === "error"
      ? "Couldn’t open this file"
      : "Nothing to preview";

  return (
    <div className={`file-viewer-status is-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span className="file-viewer-status-icon" aria-hidden="true">
        {kind === "loading" ? (
          <svg className="file-viewer-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M21 12a9 9 0 1 1-5.7-8.4" />
          </svg>
        ) : kind === "error" ? (
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5v5" />
            <path d="M12 16.5h.01" />
          </svg>
        ) : (
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h7L20 9.5v9A2.5 2.5 0 0 1 17.5 21h-11A2.5 2.5 0 0 1 4 18.5Z" />
            <path d="M13.5 3v6.5H20" />
          </svg>
        )}
      </span>
      <strong>{title}</strong>
      {message && <span>{message}</span>}
      {onRetry && (
        <button type="button" className="file-viewer-retry-button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

type DiffLine = {
  type: "unchanged" | "removed" | "added";
  text: string;
  oldLineNo: number | null;
  newLineNo: number | null;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatLanguage(language: string): string {
  const labels: Record<string, string> = {
    css: "CSS",
    html: "HTML",
    javascript: "JavaScript",
    jsx: "JavaScript React",
    json: "JSON",
    markdown: "Markdown",
    plaintext: "Plain text",
    text: "Plain text",
    tsx: "TypeScript React",
    typescript: "TypeScript",
    yaml: "YAML",
  };
  return labels[language] ?? `${language.charAt(0).toUpperCase()}${language.slice(1)}`;
}

function diffLines(patch: string): DiffLine[] {
  const files = parseUnifiedPatch(patch);
  if (!files) return [];

  return files.flatMap((file) => file.rows.flatMap((row): DiffLine[] => {
    if (row.type === "hunk") return [];
    if (row.left.type === "context" && row.right.type === "context") {
      return [{
        type: "unchanged",
        text: row.right.text,
        oldLineNo: row.left.lineNo,
        newLineNo: row.right.lineNo,
      }];
    }

    const lines: DiffLine[] = [];
    if (row.left.type === "removed") {
      lines.push({
        type: "removed",
        text: row.left.text,
        oldLineNo: row.left.lineNo,
        newLineNo: null,
      });
    }
    if (row.right.type === "added") {
      lines.push({
        type: "added",
        text: row.right.text,
        oldLineNo: null,
        newLineNo: row.right.lineNo,
      });
    }
    return lines;
  }));
}

function DiffView({ patch }: { patch: string }) {
  const { t } = useI18n();
  const diff = diffLines(patch);

  const hasChanges = diff.some((l) => l.type !== "unchanged");
  if (!hasChanges) {
    return (
      <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
        {t("i18n.noChanges")}
      </div>
    );
  }

  // Render with context: show 3 lines around each change, collapse the rest
  const CONTEXT = 3;
  const changed = new Set(diff.flatMap((l, i) => (l.type !== "unchanged" ? [i] : [])));
  const visible = new Set<number>();
  for (const ci of changed) {
    for (let j = Math.max(0, ci - CONTEXT); j <= Math.min(diff.length - 1, ci + CONTEXT); j++) {
      visible.add(j);
    }
  }

  const segments: Array<{ hidden: true; count: number } | { hidden: false; lines: DiffLine[] }> = [];
  let i = 0;
  while (i < diff.length) {
    if (visible.has(i)) {
      const block: DiffLine[] = [];
      while (i < diff.length && visible.has(i)) {
        block.push(diff[i]);
        i++;
      }
      segments.push({ hidden: false, lines: block });
    } else {
      let count = 0;
      while (i < diff.length && !visible.has(i)) {
        count++;
        i++;
      }
      segments.push({ hidden: true, count });
    }
  }

  return (
    <div
      className="file-diff-view"
      style={{
        width: "max-content",
        minWidth: "100%",
        ...FILE_CODE_STYLE,
      }}
    >
      {segments.map((seg, si) => {
        if (seg.hidden) {
          const result = (
            <div
              key={si}
              style={{
                padding: "2px 16px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                fontSize: 11,
                borderTop: "1px solid var(--border)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              ... {seg.count} unchanged lines ...
            </div>
          );
          return result;
        }
        const lines = seg.lines.map((line, li) => {
          const bg =
            line.type === "added"
              ? "rgba(0,200,80,0.12)"
              : line.type === "removed"
              ? "rgba(240,60,60,0.14)"
              : "transparent";
          const prefix =
            line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
          const prefixColor =
            line.type === "added" ? "var(--success)" : line.type === "removed" ? "var(--danger)" : "var(--text-dim)";

          return (
            <div
              key={li}
              className="file-diff-line"
              style={{
                display: "flex",
                minWidth: "100%",
                background: bg,
                borderLeft: line.type === "added"
                  ? "3px solid var(--success)"
                  : line.type === "removed"
                  ? "3px solid var(--danger)"
                  : "3px solid transparent",
              }}
            >
              <span
                style={FILE_LINE_NUMBER_STYLE}
              >
                {line.type === "removed" ? line.oldLineNo : line.newLineNo}
              </span>
              <span
                style={{
                  minWidth: 16,
                  padding: "0 6px",
                  color: prefixColor,
                  userSelect: "none",
                  flexShrink: 0,
                  fontWeight: 600,
                }}
              >
                {prefix}
              </span>
              <span
                className="file-diff-line-content"
                style={{
                  flexShrink: 0,
                  padding: "0 8px 0 0",
                  whiteSpace: "pre",
                  color: "var(--text)",
                }}
              >
                {line.text || "\u00a0"}
              </span>
            </div>
          );
        });
        return <div key={si}>{lines}</div>;
      })}
    </div>
  );
}

function ImageViewer({ filePath, cwd, sourceSessionId }: Props) {
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setNaturalSize(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [filePath, sourceSessionId]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);

  const formatSizeStr = size != null ? formatSize(size) : null;
  const metadata = [
    ext || "image",
    naturalSize ? `${naturalSize.w} × ${naturalSize.h}` : null,
    formatSizeStr,
  ].filter(Boolean).join(" · ");

  return (
    <div className="file-viewer-shell">
      <FileViewerToolbar
        filePath={filePath}
        cwd={cwd}
        metadata={metadata}
        watching={watching}
        sourceSessionId={sourceSessionId}
      />
      <div
        className="file-viewer-image-stage"
      >
        {error ? (
          <div style={{ color: "var(--danger)", fontSize: 13 }}>{error}</div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={filePath}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => setError("Failed to load image")}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}
          />
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function AudioViewer({ filePath, cwd, sourceSessionId }: Props) {
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setDuration(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setDuration(null);
      setError(null);
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [filePath, sourceSessionId]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);
  const metadata = [
    ext || "audio",
    duration != null ? formatDuration(duration) : null,
    size != null ? formatSize(size) : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="file-viewer-shell">
      <FileViewerToolbar
        filePath={filePath}
        cwd={cwd}
        metadata={metadata}
        watching={watching}
        sourceSessionId={sourceSessionId}
      />
      <div
        className="file-viewer-audio-stage"
      >
        <div style={{ width: "min(680px, 100%)" }}>
          {error && (
            <div style={{ color: "var(--danger)", fontSize: 13, marginBottom: 12, textAlign: "center" }}>
              {error}
            </div>
          )}
          <audio
            key={src}
            controls
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError("Failed to load audio")}
            style={{ width: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}

function DocumentViewer({ filePath, cwd, sourceSessionId }: Props) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const ext = getFileExt(filePath);
  const isPdf = ext === "pdf";
  const previewUrl = isPdf
    ? getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined)
    : getFileApiUrl(filePath, "preview", sourceSessionId, bust ? { v: bust } : undefined);

  useEffect(() => {
    setBust(0);
    setSize(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
      .then((r) => r.json())
      .then((d: { size?: number; error?: string }) => {
        if (d.error) setError(d.error);
        if (typeof d.size === "number") {
          setSize(d.size);
          if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
            setError("DOCX too large for preview (>10MB)");
          }
        }
      })
      .catch((e) => setError(String(e)));

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") {
          setSize(d.size);
          if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
            setError("DOCX too large for preview (>10MB)");
            return;
          }
        }
      } catch { /* ignore */ }
      setError(null);
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [filePath, isPdf, sourceSessionId]);

  const metadata = [
    ext === "docx" ? "DOCX preview" : "PDF",
    size != null ? formatSize(size) : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="file-viewer-shell">
      <FileViewerToolbar
        filePath={filePath}
        cwd={cwd}
        metadata={metadata}
        watching={watching}
        sourceSessionId={sourceSessionId}
      />
      <div className="file-viewer-document-stage">
        {error ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "var(--danger)", fontSize: 13, textAlign: "center" }}>
            {error}
          </div>
        ) : (
          <iframe
            key={previewUrl}
            src={previewUrl}
            sandbox={isPdf ? undefined : "allow-same-origin"}
            title={t("i18n.previewFile", { file: getFileName(filePath) })}
            style={{ width: "100%", height: "100%", border: "none", background: isPdf ? "var(--bg)" : "#eef1f5" }}
          />
        )}
      </div>
    </div>
  );
}

export function FileViewer({ filePath, cwd, sourceSessionId, onOpenFile, onMentionLines, gitRefreshKey, initialDisplayMode }: Props) {
  if (isImagePath(filePath)) {
    return <ImageViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />;
  }
  if (isAudioPath(filePath)) {
    return <AudioViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />;
  }
  if (isDocumentPreviewPath(filePath)) {
    return <DocumentViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} />;
  }
  return <TextFileViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} onOpenFile={onOpenFile} onMentionLines={onMentionLines} gitRefreshKey={gitRefreshKey} initialDisplayMode={initialDisplayMode} />;
}

function TextFileViewer({ filePath, cwd, sourceSessionId, onOpenFile, onMentionLines, gitRefreshKey, initialDisplayMode }: Props) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  const [data, setData] = useState<FileData | null>(null);
  const [loadedFilePath, setLoadedFilePath] = useState<string | null>(null);
  const [gitDiff, setGitDiff] = useState<GitFileDiffResponse | null>(null);
  const [gitDiffLoading, setGitDiffLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const displayModeKey = `${filePath}\u0000${initialDisplayMode ?? ""}`;
  const defaultDisplayMode = getDefaultDisplayMode(filePath, initialDisplayMode);
  const [displayModeState, setDisplayModeState] = useState<{ key: string; mode: DisplayMode }>(() => ({
    key: displayModeKey,
    mode: defaultDisplayMode,
  }));
  // Derive the mode synchronously from the current file. This prevents the
  // previous file's mode from rendering for one frame while a new file loads.
  const displayMode = displayModeState.key === displayModeKey
    ? displayModeState.mode
    : defaultDisplayMode;
  const setDisplayMode = useCallback((mode: DisplayMode) => {
    setDisplayModeState({ key: displayModeKey, mode });
  }, [displayModeKey]);
  const [wrapLines, setWrapLines] = useState(false);
  const [watching, setWatching] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const esRef = useRef<EventSource | null>(null);
  const gitDiffRequestRef = useRef(0);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [selectedLineRange, setSelectedLineRange] = useState<SelectedLineRange | null>(null);

  useEffect(() => {
    const toggleWrap = () => setWrapLines((value) => !value);
    window.addEventListener("pi:file-toggle-wrap", toggleWrap);
    return () => window.removeEventListener("pi:file-toggle-wrap", toggleWrap);
  }, []);

  const fetchContent = useCallback((filePath: string) => {
    return fetch(getFileApiUrl(filePath, "read", sourceSessionId))
      .then((r) => r.json())
      .then((d: FileData & { error?: string }) => {
        if (d.error) {
          setError(d.error);
          setLoadedFilePath(filePath);
          return null;
        }
        setError(null);
        setData(d);
        setLoadedFilePath(filePath);
        return d;
      })
      .catch((e) => {
        setError(String(e));
        setLoadedFilePath(filePath);
        return null;
      });
  }, [sourceSessionId]);

  const fetchGitDiff = useCallback(async (targetPath: string) => {
    const requestId = ++gitDiffRequestRef.current;
    setGitDiffLoading(true);
    if (!cwd) {
      setGitDiff(null);
      setGitDiffLoading(false);
      return;
    }

    try {
      const params = new URLSearchParams({ cwd, path: targetPath });
      const response = await fetch(`/api/git/diff?${params.toString()}`);
      const next = await response.json() as GitFileDiffResponse & { error?: string };
      if (requestId !== gitDiffRequestRef.current) return;
      setGitDiff(response.ok && next.supported && typeof next.patch === "string" ? next : null);
    } catch {
      if (requestId === gitDiffRequestRef.current) setGitDiff(null);
    } finally {
      if (requestId === gitDiffRequestRef.current) setGitDiffLoading(false);
    }
  }, [cwd]);

  // Initial load + SSE watch setup
  useEffect(() => {
    setLoading(true);
    setError(null);
    setData(null);
    setGitDiff(null);
    setWrapLines(false);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    fetchContent(filePath).finally(() => setLoading(false));

    // Set up SSE watch
    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
    });

    es.addEventListener("change", () => {
      void fetchContent(filePath);
      void fetchGitDiff(filePath);
      setPreviewReloadKey((value) => value + 1);
    });

    es.addEventListener("error", () => {
      setWatching(false);
    });

    es.onerror = () => {
      setWatching(false);
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [filePath, fetchContent, fetchGitDiff, sourceSessionId, reloadKey]);

  useEffect(() => {
    void fetchGitDiff(filePath);
  }, [fetchGitDiff, filePath, gitRefreshKey]);

  const hasGitDiff = gitDiff?.supported === true && typeof gitDiff.patch === "string";
  const isDeletedDiff = hasGitDiff && gitDiff.status === "deleted";

  useEffect(() => {
    if (!hasGitDiff && displayMode === "diff") {
      setDisplayMode(defaultDisplayMode === "diff" ? "source" : defaultDisplayMode);
    }
  }, [defaultDisplayMode, displayMode, hasGitDiff, setDisplayMode]);

  useEffect(() => {
    if (!isDeletedDiff || !esRef.current) return;
    esRef.current.close();
    esRef.current = null;
    setWatching(false);
  }, [isDeletedDiff]);

  // Opened from the Changes list (initialDisplayMode === "diff"): switch to the
  // diff view once the git diff has resolved. We do this after the diff loads
  // rather than at mount so files without a diff never flash an empty diff view.
  const autoDiffAppliedRef = useRef(false);
  useEffect(() => {
    autoDiffAppliedRef.current = false;
  }, [filePath]);
  useEffect(() => {
    if (initialDisplayMode === "diff" && hasGitDiff && !autoDiffAppliedRef.current) {
      autoDiffAppliedRef.current = true;
      setDisplayMode("diff");
    }
  }, [hasGitDiff, initialDisplayMode, setDisplayMode]);

  const markdownPreview = useMemo(
    () => (data?.language === "markdown" ? normalizeDisplayMath(data.content) : ""),
    [data],
  );

  useEffect(() => {
    const updateSelectedLineRange = () => {
      const root = contentRef.current;
      setSelectedLineRange(
        onMentionLines && displayMode === "source" && root
          ? getSelectedSourceLineRange(root, window.getSelection())
          : null,
      );
    };

    updateSelectedLineRange();
    if (!onMentionLines || displayMode !== "source") return;

    document.addEventListener("selectionchange", updateSelectedLineRange);
    return () => document.removeEventListener("selectionchange", updateSelectedLineRange);
  }, [data?.content, displayMode, onMentionLines]);

  const mentionLineRange = useCallback((lineRange: SelectedLineRange | null) => {
    if (!onMentionLines || !lineRange) return;
    onMentionLines(
      getRelativeFilePath(filePath, cwd),
      lineRange.startLine,
      lineRange.endLine,
    );
  }, [cwd, filePath, onMentionLines]);

  const handleMentionSelectedLines = useCallback(() => {
    mentionLineRange(selectedLineRange);
  }, [mentionLineRange, selectedLineRange]);

  useEffect(() => {
    if (!onMentionLines || displayMode !== "source") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.key.toLowerCase() !== "i" || (!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return;

      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) return;

      const root = contentRef.current;
      const lineRange = root ? getSelectedSourceLineRange(root, window.getSelection()) : null;
      if (!lineRange) return;

      event.preventDefault();
      mentionLineRange(lineRange);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [displayMode, mentionLineRange, onMentionLines]);

  if (loading || loadedFilePath !== filePath || (initialDisplayMode === "diff" && gitDiffLoading && !data)) {
    return <FileViewerStatus kind="loading" message={getFileName(filePath)} />;
  }

  if (error && !isDeletedDiff) {
    return (
      <FileViewerStatus
        kind="error"
        message={error}
        onRetry={() => setReloadKey((value) => value + 1)}
      />
    );
  }

  if (!data && !isDeletedDiff) return <FileViewerStatus kind="empty" />;

  const language = data?.language ?? "text";
  const content = data?.content ?? "";
  const isHtml = language === "html";
  const isMarkdown = language === "markdown";
  const hasPreview = isHtml || isMarkdown;
  const markdownDirectory = getFileDirectory(filePath);
  const lines = content.split("\n");
  const effectiveDisplayMode = isDeletedDiff ? "diff" : displayMode;
  const htmlPreviewUrl = getFileApiUrl(filePath, "serve", sourceSessionId, { v: previewReloadKey });
  const displayModes: DisplayMode[] = isDeletedDiff
    ? ["diff"]
    : [
        "source",
        ...(hasPreview ? ["preview" as const] : []),
        ...(hasGitDiff ? ["diff" as const] : []),
      ];
  const lineCount = `${lines.length} ${lines.length === 1 ? "line" : "lines"}`;
  const metadata = isDeletedDiff
    ? t("files.deleted")
    : `${formatLanguage(language)} · ${lineCount} · ${formatSize(data!.size)}`;

  return (
    <div className="file-viewer-shell">
      <FileViewerToolbar
        filePath={filePath}
        cwd={cwd}
        metadata={metadata}
        watching={watching}
        sourceSessionId={sourceSessionId}
      >
        {displayModes.length > 1 && (
          <div className="file-viewer-mode-switch" aria-label={t("i18n.fileViewMode")}>
            {displayModes.map((mode) => {
              const active = effectiveDisplayMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setDisplayMode(mode)}
                  title={mode === "diff" ? t("i18n.compareHead") : undefined}
                  aria-pressed={active}
                  className="file-viewer-mode-button"
                >
                  {DISPLAY_MODE_LABELS[mode]}
                </button>
              );
            })}
          </div>
        )}

        {effectiveDisplayMode === "source" && (
          <div className="file-viewer-action-slot">
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={handleMentionSelectedLines}
                title={t("i18n.mentionSelectedLines")}
                aria-label={t("i18n.mentionSelectedLines")}
                disabled={!selectedLineRange}
                className="file-viewer-icon-button"
              >
                <MentionIcon />
              </button>
              <button
                type="button"
                onClick={() => setWrapLines((value) => !value)}
                title={wrapLines ? t("i18n.disableWrap") : t("i18n.enableWrap")}
                aria-label={wrapLines ? t("i18n.disableWrap") : t("i18n.enableWrap")}
                aria-pressed={wrapLines}
                className="file-viewer-icon-button"
                style={{
                  background: wrapLines ? "var(--bg-selected)" : "transparent",
                  color: wrapLines ? "var(--text)" : "var(--text-muted)",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h18" />
                  <path d="M3 12h15a3 3 0 1 1 0 6h-4" />
                  <path d="m16 16-2 2 2 2" />
                  <path d="M3 18h7" />
                </svg>
              </button>
          </div>
        )}
      </FileViewerToolbar>

      {/* Content area */}
      <div ref={contentRef} className="file-viewer-content" style={{ flex: 1, overflow: "auto", background: "var(--bg)" }}>
        {effectiveDisplayMode === "diff" && hasGitDiff ? (
          <DiffView patch={gitDiff.patch!} />
        ) : isHtml && effectiveDisplayMode === "preview" ? (
          <iframe
            key={htmlPreviewUrl}
            src={htmlPreviewUrl}
            style={{ width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
            title={t("i18n.htmlPreview")}
          />
        ) : isMarkdown && effectiveDisplayMode === "preview" ? (
          <div
            className="markdown-body markdown-file-preview"
            style={{ padding: "24px 32px" }}
          >
            <ReactMarkdown
              remarkPlugins={markdownPreviewRemarkPlugins}
              rehypePlugins={markdownPreviewRehypePlugins}
              components={{
                code({ className, children, ...props }) {
                  const lang = className?.replace("language-", "").toLowerCase() ?? "";
                  const raw = String(children);
                  const isBlock = className?.includes("language-") || raw.includes("\n");
                  if (isBlock) {
                    if (lang === "mermaid") {
                      return <MermaidBlock code={raw.replace(/\n$/, "")} defaultPreview />;
                    }
                    return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />;
                  }
                  return (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
                pre({ children }) {
                  // Render the code block directly — CodeBlock provides its own wrapping.
                  // For non-mermaid blocks, pass through to default pre rendering.
                  return <>{children}</>;
                },
                a({ href, children, ...props }) {
                  delete props.node;
                  const linkedFile = onOpenFile
                    ? resolveLocalFileHref(href, markdownDirectory, cwd ?? markdownDirectory)
                    : null;
                  if (!linkedFile || !onOpenFile) {
                    return <a href={href} {...props}>{children}</a>;
                  }

                  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
                    if (event.defaultPrevented || event.button !== 0) return;
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    onOpenFile(linkedFile);
                  };

                  return <a href={href} {...props} onClick={handleClick}>{children}</a>;
                },
                img({ src, alt, ...props }) {
                  delete props.node;
                  const imagePath = typeof src === "string"
                    ? resolveLocalFileHref(src, markdownDirectory, cwd ?? markdownDirectory)
                    : null;
                  const imageSrc = imagePath
                    ? getFileApiUrl(imagePath, "read", sourceSessionId)
                    : src;
                  // Dynamic local paths are served directly by the file API.
                  // eslint-disable-next-line @next/next/no-img-element
                  return <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
                },
              }}
            >
              {markdownPreview}
            </ReactMarkdown>
          </div>
        ) : (
          <SyntaxHighlighter
            className={wrapLines ? "file-source-view is-wrapped" : "file-source-view"}
            language={language === "text" ? "plaintext" : language}
            style={isDark ? vscDarkPlus : vs}
            showLineNumbers
            lineNumberStyle={{
              ...FILE_LINE_NUMBER_STYLE,
            }}
            customStyle={{
              margin: 0,
              padding: 0,
              border: 0,
              backgroundColor: "var(--bg)",
              ...FILE_CODE_STYLE,
              width: wrapLines ? "100%" : "max-content",
              minWidth: "100%",
              minHeight: "100%",
              overflow: "visible",
            }}
            codeTagProps={{
              style: {
                fontFamily: "var(--font-mono)",
                overflowWrap: wrapLines ? "anywhere" : "normal",
              },
            }}
            renderer={(rendererProps) => (
              <SourceCodeRenderer {...rendererProps} wrapLines={wrapLines} />
            )}
            wrapLongLines={wrapLines}
          >
            {content}
          </SyntaxHighlighter>
        )}
      </div>
    </div>
  );
}
