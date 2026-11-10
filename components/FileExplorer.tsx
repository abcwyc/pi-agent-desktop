"use client";

import { forwardRef, useState, useCallback, useEffect, useImperativeHandle, useMemo, useRef, type CSSProperties } from "react";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { DismissButton } from "./DismissButton";
import {
  encodeFilePathForApi,
  getFileDirectory,
  getFileName,
  getRelativeFilePath,
  joinFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";
import type { FileIndexEntry } from "@/lib/file-fuzzy";
import { uploadFiles, type DroppedItem, type UploadConflictStrategy, type UploadError, type UploadResponse } from "@/lib/file-upload-client";
import { droppedItems } from "@/hooks/useDragDrop";
import { buildSearchTree, type SearchTreeNode } from "@/lib/search-tree";
import type { FileTreeHiddenReason } from "@/lib/file-tree-visibility";
import { useI18n } from "@/hooks/useI18n";
import { APP_PREF_KEYS, getPref, setPref } from "@/lib/app-prefs";
import { isImeComposing } from "@/lib/ime";
type Translate = ReturnType<typeof useI18n>["t"];

/** Why a listed entry is normally left out; only listings with `hidden=1` report it. */
type HiddenReason = Exclude<FileTreeHiddenReason, "always">;

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
  /** Where a directory link leads when that is outside the browsable roots. */
  outsideLinkTarget?: string;
  /** That target contains the project or the home folder. */
  outsideLinkEncloses?: boolean;
  hidden?: HiddenReason;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
  outsideLinkTarget?: string;
  outsideLinkEncloses?: boolean;
  hidden?: HiddenReason;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onUploadBusyChange?: (busy: boolean) => void;
  changesCollapsed: boolean;
  onChangesCountChange?: (count: number) => void;
  fileSearchOpen?: boolean;
  onFileSearchOpenChange?: (open: boolean) => void;
  /** Also list what Git ignores, dimmed (the explorer bar's switch). */
  showHidden?: boolean;
}

export interface FileExplorerHandle {
  openUploadPicker: () => void;
}

type UploadPhase = "idle" | "checking" | "uploading";

interface UploadSummary {
  /** The folder the files went to: the project root, or the folder they were dropped on (F4). */
  directory: string;
  uploaded: string[];
  skipped: string[];
  errors: UploadError[];
}

interface PendingConflict {
  directory: string;
  files: File[];
  conflicts: string[];
  nonReplaceable: string[];
}

async function responseError(res: Response, fallback: string): Promise<Error> {
  let message = `${fallback} (HTTP ${res.status})`;
  try {
    const data = await res.json() as { error?: string };
    if (data.error) message = data.error;
  } catch {
    // ignore non-JSON error bodies
  }
  return new Error(message);
}

async function fetchEntries(dirPath: string, showHidden = false): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list${showHidden ? "&hidden=1" : ""}`);
  if (!res.ok) throw await responseError(res, "Failed to load files");
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
    outsideLinkTarget: e.outsideLinkTarget,
    outsideLinkEncloses: e.outsideLinkEncloses,
    hidden: e.hidden,
  }));
}

// Sends the target the operator was shown, so a link pointed elsewhere since
// the listing is refused instead of granting a directory nobody looked at.
async function allowOutsideLink(linkPath: string, target: string): Promise<void> {
  const res = await fetch(`/api/files/${encodeFilePathForApi(linkPath)}?type=allow-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
  if (!res.ok) throw await responseError(res, "Failed to allow the linked folder");
}

async function fetchGitStatus(cwd: string): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`/api/git/status?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to load Git status (HTTP ${res.status})`);
  return res.json() as Promise<GitStatusResponse>;
}

const GIT_STATUS_KEYS: Record<GitFileStatusKind, string> = {
  modified: "files.modified",
  added: "files.added",
  deleted: "files.deleted",
  renamed: "files.renamed",
  untracked: "files.untracked",
  conflict: "files.conflict",
};

const GIT_STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "#d6a84b",
  added: "var(--success)",
  deleted: "var(--danger)",
  renamed: "#60a5fa",
  untracked: "var(--success)",
  conflict: "var(--danger)",
};

function GitStatusBadge({ status, t }: { status: GitFileStatus; t: Translate }) {
  return (
    <span
      title={t(GIT_STATUS_KEYS[status.status])}
      aria-label={t(GIT_STATUS_KEYS[status.status])}
      style={{
        width: 14,
        height: 14,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: GIT_STATUS_COLORS[status.status],
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-micro)",
        fontWeight: "var(--fw-semibold)",
      }}
    >
      {status.code}
    </span>
  );
}

function MentionIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

function OutsideLinkIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

// Listed only while the explorer shows ignored files: dimmed like VS Code's
// ignored entries, the reason in the name's tooltip.
const HIDDEN_ENTRY_OPACITY = 0.55;
const HIDDEN_REASON_KEYS = {
  ignored: "files.hiddenIgnored",
  excluded: "files.hiddenExcluded",
} as const satisfies Record<HiddenReason, string>;

export function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  refreshToken,
  highlightedPaths,
  gitStatusByPath,
  changedDirectoryPaths,
  showHidden = false,
  parentHidden,
  dropTargetPath,
  onDropFiles,
  onDropTargetChange,
  t,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshToken?: string;
  highlightedPaths: Set<string>;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  showHidden?: boolean;
  /** Set inside a hidden directory: Git has no answer there, so its entries inherit the reason. */
  parentHidden?: HiddenReason;
  /** F4: the folder row a file drag is over; files dropped on a folder upload into it. */
  dropTargetPath?: string | null;
  onDropFiles?: (directory: string, items: DroppedItem[]) => void;
  onDropTargetChange?: (path: string | null) => void;
  t: Translate;
}) {
  const open = expandedPaths.has(node.fullPath);
  const isDropTarget = node.isDir && dropTargetPath === node.fullPath;
  const hidden = node.hidden ?? parentHidden;
  const highlighted = highlightedPaths.has(node.fullPath);
  const normalizedPath = normalizeFilePathSlashes(node.fullPath);
  const gitStatus = gitStatusByPath.get(normalizedPath);
  const containsGitChanges = node.isDir && (
    gitStatus !== undefined || changedDirectoryPaths.has(normalizedPath)
  );
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [allowedLinkTarget, setAllowedLinkTarget] = useState<string | null>(null);
  const [allowingLink, setAllowingLink] = useState(false);
  const [allowLinkError, setAllowLinkError] = useState<string | null>(null);
  const [confirmEnclosingLink, setConfirmEnclosingLink] = useState(false);
  // A link leading outside the project is refused until the operator allows
  // its target, so it asks for that instead of listing (#748).
  const pendingLinkTarget = node.outsideLinkTarget && node.outsideLinkTarget !== allowedLinkTarget
    ? node.outsideLinkTarget
    : null;

  // A listing that reports the link again (a server restart forgets allowed
  // targets, or the link was pointed elsewhere) needs a new decision.
  useEffect(() => {
    setAllowedLinkTarget(null);
    setAllowLinkError(null);
    setConfirmEnclosingLink(false);
  }, [node.outsideLinkTarget]);

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    setLoadError(null);
    try {
      const entries = await fetchEntries(node.fullPath, showHidden);
      setChildren(entries);
      setLoaded(true);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath, showHidden]);

  // The switch changes what every listing holds: reload an open directory now
  // and a collapsed one when it next opens.
  const listedShowHiddenRef = useRef(showHidden);
  useEffect(() => {
    if (listedShowHiddenRef.current === showHidden) return;
    listedShowHiddenRef.current = showHidden;
    if (!loaded) return;
    if (open && !pendingLinkTarget) loadChildren(true);
    else setLoaded(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  // A hidden directory left expanded mounts open again when the switch comes
  // back on, before anything listed it.
  useEffect(() => {
    if (node.isDir && open && !loaded && !pendingLinkTarget) loadChildren();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch children when the tree refreshes and the directory is open.
  useEffect(() => {
    if (refreshToken !== undefined && open && loaded && !pendingLinkTarget) {
      loadChildren(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      const next = !open;
      onToggleExpanded(node.fullPath, next);
      if (next && !loaded && !pendingLinkTarget) loadChildren();
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, loaded, open, pendingLinkTarget, loadChildren, onOpenFile, onToggleExpanded]);

  const handleAllowLink = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!pendingLinkTarget) return;
    // A link to `/`, `~` or a parent of the project opens far more than a
    // sibling folder, and a cloned repository can contain one.
    if (node.outsideLinkEncloses && !confirmEnclosingLink) {
      setConfirmEnclosingLink(true);
      return;
    }
    setConfirmEnclosingLink(false);
    setAllowingLink(true);
    setAllowLinkError(null);
    try {
      await allowOutsideLink(node.fullPath, pendingLinkTarget);
      setAllowedLinkTarget(pendingLinkTarget);
      await loadChildren(true);
    } catch (error) {
      setAllowLinkError(error instanceof Error ? error.message : String(error));
    } finally {
      setAllowingLink(false);
    }
  }, [node.fullPath, node.outsideLinkEncloses, confirmEnclosingLink, pendingLinkTarget, loadChildren]);

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        title={node.fullPath}
        onClick={handleClick}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          handleClick();
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onDragOver={node.isDir && onDropFiles ? (event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
          onDropTargetChange?.(node.fullPath);
        } : undefined}
        onDrop={node.isDir && onDropFiles ? (event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.stopPropagation();
          onDropTargetChange?.(null);
          onDropFiles(node.fullPath, droppedItems(event.dataTransfer));
        } : undefined}
        className={isDropTarget ? "file-tree-drop-target" : undefined}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 8 + depth * 14,
          paddingRight: 8,
          height: 24,
          cursor: "pointer",
          background: isDropTarget ? undefined : hovered ? "var(--bg-hover)" : "transparent",
          borderRadius: "var(--radius-xs)",
          userSelect: "none",
        }}
      >
        {node.isDir && (
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast) var(--ease-native)" }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
        )}
        {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center", opacity: hidden ? HIDDEN_ENTRY_OPACITY : 1 }}>
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        <span
          data-hidden-reason={hidden}
          style={{
            fontSize: "var(--fs-caption)",
            color: hidden ? "var(--text-muted)" : "var(--text)",
            opacity: hidden ? HIDDEN_ENTRY_OPACITY : 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={hidden ? `${node.fullPath}\n${t(HIDDEN_REASON_KEYS[hidden])}` : node.fullPath}
        >
          {node.name}
        </span>
        {!hovered && pendingLinkTarget && (
          <span
            title={t("files.outsideLink", { target: pendingLinkTarget })}
            aria-label={t("files.outsideLink", { target: pendingLinkTarget })}
            style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}
          >
            <OutsideLinkIcon />
          </span>
        )}
        {highlighted && (
          <span
            title={t("files.newlyUploaded")}
            aria-label={t("files.newlyUploaded")}
            style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6" }} />
          </span>
        )}
        {!hovered && !node.isDir && gitStatus && (
          <GitStatusBadge status={gitStatus} t={t} />
        )}
        {!hovered && containsGitChanges && (
          <span
            title={t("files.containsChangedFiles")}
            aria-label={t("files.containsChangedFiles")}
            style={{
              width: 14,
              height: 14,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#d6a84b" }} />
          </span>
        )}
        {loading && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
        {onAtMention && hovered && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir);
            }}
            title={t("files.insertPath")}
            style={{
              position: "absolute",
              right: !node.isDir ? 28 : 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 8px",
              height: 20,
              background: "var(--bg-panel)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-xs)",
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: "var(--fs-micro)",
              fontWeight: "var(--fw-semibold)",
              whiteSpace: "nowrap",
            }}
          >
            <MentionIcon />
            {t("files.mention")}
          </button>
        )}
        {hovered && !node.isDir && (
          <a
            href={`/api/files/${encodeFilePathForApi(node.fullPath)}?type=download`}
            download
            onClick={(e) => e.stopPropagation()}
            title={t("files.download")}
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 5px",
              height: 20,
              background: "var(--bg-panel)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-xs)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: "var(--fs-micro)",
              fontWeight: "var(--fw-semibold)",
              whiteSpace: "nowrap",
              textDecoration: "none",
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </a>
        )}
      </div>
      {node.isDir && open && pendingLinkTarget && (
        <div
          style={{
            paddingLeft: 8 + (depth + 1) * 14,
            paddingRight: 8,
            paddingTop: 3,
            paddingBottom: 5,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 4,
            fontSize: "var(--fs-micro)",
            color: "var(--text-dim)",
          }}
        >
          <span style={{ wordBreak: "break-all" }}>{t("files.outsideLink", { target: pendingLinkTarget })}</span>
          {node.outsideLinkEncloses && (
            <span
              style={{
                color: "var(--warning)",
                display: "flex",
                flexDirection: "column",
                gap: 3,
                wordBreak: "break-word",
              }}
            >
              {t("files.outsideLinkEncloses")}
              {confirmEnclosingLink && (
                <span>{t("files.allowEnclosingLinkConfirm", { target: pendingLinkTarget })}</span>
              )}
            </span>
          )}
          <button
            type="button"
            onClick={handleAllowLink}
            disabled={allowingLink}
            title={t("files.allowOutsideLinkTitle", { target: pendingLinkTarget })}
            aria-live="polite"
            style={{
              height: 20,
              padding: "0 8px",
              background: "var(--bg-panel)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-xs)",
              color: "var(--accent)",
              cursor: allowingLink ? "default" : "pointer",
              opacity: allowingLink ? 0.6 : 1,
              fontSize: "var(--fs-micro)",
              fontWeight: "var(--fw-semibold)",
              whiteSpace: "nowrap",
            }}
          >
            {node.outsideLinkEncloses && confirmEnclosingLink
              ? t("common.confirmDelete")
              : t("files.allowOutsideLink")}
          </button>
          {allowLinkError && (
            <span role="alert" style={{ color: "var(--danger)", wordBreak: "break-word" }}>{allowLinkError}</span>
          )}
        </div>
      )}
      {node.isDir && open && !pendingLinkTarget && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              refreshToken={refreshToken}
              highlightedPaths={highlightedPaths}
              gitStatusByPath={gitStatusByPath}
              changedDirectoryPaths={changedDirectoryPaths}
              showHidden={showHidden}
              parentHidden={hidden}
              dropTargetPath={dropTargetPath}
              onDropFiles={onDropFiles}
              onDropTargetChange={onDropTargetChange}
              t={t}
            />
          ))}
          {children.length === 0 && loaded && !loadError && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: "var(--fs-micro)", color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center" }}>
              empty
            </div>
          )}
          {loadError && (
            <div role="alert" style={{ paddingLeft: 8 + (depth + 1) * 14, paddingRight: 8, paddingTop: 3, paddingBottom: 3, fontSize: "var(--fs-micro)", color: "var(--danger)", wordBreak: "break-word" }}>
              {loadError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type OpenFileOptions = { sourceSessionId?: string | null; modeHint?: "diff" };

type OpenFileHandler = (filePath: string, fileName: string, options?: OpenFileOptions) => void;

function ChangeRow({
  status,
  cwd,
  onOpenFile,
  onAtMention,
  t,
  depth = 0,
  treeMode = false,
}: {
  status: GitFileStatus;
  cwd: string;
  onOpenFile: OpenFileHandler;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  t: Translate;
  depth?: number;
  /** F2: inside the changes tree the folders name the path, so only the file name shows. */
  treeMode?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const name = getFileName(status.filePath);
  const rel = getRelativeFilePath(status.filePath, cwd);
  // Split the path so the directory part ellipsizes while the file name stays fully visible
  const lastSlash = rel.lastIndexOf("/");
  const dirPart = !treeMode && lastSlash >= 0 ? rel.slice(0, lastSlash + 1) : "";
  const baseName = treeMode ? name : (lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel);
  return (
    <div
      onClick={() => onOpenFile(status.filePath, name, { modeHint: "diff" })}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={status.filePath}
      style={{
        display: "flex",
        alignItems: "center",
        gap: treeMode ? 4 : 6,
        paddingLeft: treeMode ? 8 + depth * 14 : 10,
        paddingRight: 8,
        height: 24,
        cursor: "pointer",
        background: hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: "var(--radius-xs)",
        userSelect: "none",
        position: "relative",
      }}
    >
      <GitStatusBadge status={status} t={t} />
      {treeMode && <span style={{ width: 10, flexShrink: 0 }} />}
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center", opacity: 0.85 }}>
        {getFileIcon(name, 13)}
      </span>
      <span
        title={status.filePath}
        style={{
          fontSize: "var(--fs-caption)",
          color: "var(--text)",
          display: "flex",
          alignItems: "center",
          minWidth: 0,
          flex: 1,
        }}
      >
        {dirPart && (
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: "0 1 auto",
              minWidth: 0,
              color: "var(--text-dim)",
            }}
          >
            {dirPart}
          </span>
        )}
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flexShrink: treeMode ? 1 : 0,
            maxWidth: "100%",
          }}
        >
          {baseName}
        </span>
      </span>
      {onAtMention && hovered && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAtMention(rel, false);
          }}
          title={t("files.insertPath")}
          style={{
            position: "absolute",
            right: 4,
            top: "50%",
            transform: "translateY(-50%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
            padding: "0 8px",
            height: 20,
            background: "var(--bg-panel)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-xs)",
            color: "var(--accent)",
            cursor: "pointer",
            fontSize: "var(--fs-micro)",
            fontWeight: "var(--fw-semibold)",
            whiteSpace: "nowrap",
          }}
        >
          <MentionIcon />
          {t("files.mention")}
        </button>
      )}
    </div>
  );
}

type ChangesViewMode = "list" | "tree";

function loadChangesViewMode(): ChangesViewMode {
  return getPref(APP_PREF_KEYS.changesViewMode) === "tree" ? "tree" : "list";
}

function ChangesFolderRow({
  node,
  depth,
  open,
  onToggle,
}: {
  node: SearchTreeNode;
  depth: number;
  open: boolean;
  onToggle: (path: string, open: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      role="button"
      aria-expanded={open}
      onClick={() => onToggle(node.path, !open)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={node.path}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        paddingLeft: 8 + depth * 14,
        paddingRight: 8,
        height: 24,
        cursor: "pointer",
        background: hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: "var(--radius-xs)",
        userSelect: "none",
      }}
    >
      <svg
        width="10" height="10" viewBox="0 0 10 10" fill="none"
        stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
        style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}
        aria-hidden="true"
      >
        <polyline points="3 2 7 5 3 8" />
      </svg>
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
        <FolderIcon size={14} open={open} />
      </span>
      <span
        style={{
          fontSize: "var(--fs-caption)",
          color: "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
      >
        {node.name}
      </span>
    </div>
  );
}

function ChangesTreeRows({
  nodes,
  depth,
  cwd,
  statusByPath,
  collapsedPaths,
  onToggleExpanded,
  onOpenFile,
  onAtMention,
  t,
}: {
  nodes: SearchTreeNode[];
  depth: number;
  cwd: string;
  statusByPath: Map<string, GitFileStatus>;
  collapsedPaths: Set<string>;
  onToggleExpanded: (path: string, open: boolean) => void;
  onOpenFile: OpenFileHandler;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  t: Translate;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.isDir) {
          const open = !collapsedPaths.has(node.path);
          return (
            <div key={`dir:${node.path}`}>
              <ChangesFolderRow node={node} depth={depth} open={open} onToggle={onToggleExpanded} />
              {open && (
                <ChangesTreeRows
                  nodes={node.children}
                  depth={depth + 1}
                  cwd={cwd}
                  statusByPath={statusByPath}
                  collapsedPaths={collapsedPaths}
                  onToggleExpanded={onToggleExpanded}
                  onOpenFile={onOpenFile}
                  onAtMention={onAtMention}
                  t={t}
                />
              )}
            </div>
          );
        }
        const status = statusByPath.get(node.path);
        if (!status) return null;
        return (
          <ChangeRow
            key={status.filePath}
            status={status}
            cwd={cwd}
            onOpenFile={onOpenFile}
            onAtMention={onAtMention}
            t={t}
            depth={depth}
            treeMode
          />
        );
      })}
    </>
  );
}

function ChangesViewToggleIcon({ mode }: { mode: ChangesViewMode }) {
  if (mode === "tree") {
    // List icon: switching back to the flat list
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" />
        <path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" />
      </svg>
    );
  }
  // Tree icon: switching to the folder tree
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3v12" /><path d="M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      <path d="M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      <path d="M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      <path d="M9 12h6" /><path d="M12 12v3" />
    </svg>
  );
}

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({
  cwd,
  onOpenFile,
  refreshKey,
  onAtMention,
  onAtMentions,
  onUploadBusyChange,
  changesCollapsed,
  onChangesCountChange,
  fileSearchOpen = false,
  onFileSearchOpenChange,
  showHidden = false,
}, ref) {
  const { t } = useI18n();
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const [gitLineStats, setGitLineStats] = useState({ additions: 0, deletions: 0 });
  // F2: the changes as a flat list or a folder tree, remembered per browser.
  const [changesViewMode, setChangesViewMode] = useState<ChangesViewMode>("list");
  // Folders stay open unless collapsed here, so a refresh or a newly changed folder never folds them.
  const [collapsedChangeDirs, setCollapsedChangeDirs] = useState<Set<string>>(() => new Set());
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const [searchPaths, setSearchPaths] = useState<string[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const prevCwdRef = useRef<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;
  const uploadBusy = uploadPhase !== "idle";
  const hasSearchQuery = searchQuery.trim().length > 0;

  // Reuse the cached, bounded file index used by @ mentions.
  useEffect(() => {
    if (!fileSearchOpen) return;
    const query = searchQuery.trim();
    if (!query) {
      setSearchPaths([]);
      setSearchLoading(false);
      setSearchError(false);
      return;
    }
    const controller = new AbortController();
    setSearchLoading(true);
    setSearchError(false);
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() as Promise<{ matches?: FileIndexEntry[] }> : Promise.reject(new Error("Search failed")))
        .then((data) => setSearchPaths((data.matches ?? []).filter((entry) => !entry.isDir).map((entry) => entry.path)))
        .catch(() => {
          if (!controller.signal.aborted) {
            setSearchPaths([]);
            setSearchError(true);
          }
        })
        .finally(() => { if (!controller.signal.aborted) setSearchLoading(false); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [cwd, fileSearchOpen, searchQuery]);

  // Focus the search input whenever the search panel opens.
  useEffect(() => {
    if (fileSearchOpen) searchInputRef.current?.focus();
  }, [fileSearchOpen]);

  // Results render as a tree; keep every directory that contains a match
  // expanded, while preserving the user's manual collapses as they type.
  useEffect(() => {
    if (searchPaths.length === 0) return;
    const dirs = new Set<string>();
    for (const relative of searchPaths) {
      const parts = relative.split("/");
      let path = "";
      for (let i = 0; i < parts.length - 1; i++) {
        path = path ? `${path}/${parts[i]}` : parts[i];
        dirs.add(joinFilePath(cwd, path));
      }
    }
    setSearchExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const dir of dirs) {
        if (!next.has(dir)) { next.add(dir); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [cwd, searchPaths]);

  const searchRoots = useMemo(() => {
    const toFileNode = (node: SearchTreeNode): FileNode => ({
      name: node.name,
      fullPath: joinFilePath(cwd, node.path),
      isDir: node.isDir,
      size: 0,
      children: node.children.map(toFileNode),
      loaded: true,
    });
    return buildSearchTree(searchPaths).map(toFileNode);
  }, [cwd, searchPaths]);

  const gitStatusByPath = useMemo(() => new Map(
    gitFiles.map((status) => [normalizeFilePathSlashes(status.filePath), status]),
  ), [gitFiles]);

  const changedDirectoryPaths = useMemo(() => {
    const directories = new Set<string>();
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    for (const status of gitFiles) {
      let directory = getFileDirectory(normalizeFilePathSlashes(status.filePath));
      while (directory === normalizedCwd || directory.startsWith(`${normalizedCwd}/`)) {
        directories.add(directory);
        if (directory === normalizedCwd) break;
        const parent = getFileDirectory(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return directories;
  }, [cwd, gitFiles]);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  const applyUploadResult = useCallback((data: UploadResponse, directory: string) => {
    const uploaded = data.uploaded ?? [];
    const skipped = data.skipped ?? [];
    const errors = data.errors ?? [];
    setUploadSummary({ directory, uploaded, skipped, errors });

    if (uploaded.length > 0) {
      setHighlightedPaths(new Set(uploaded.map((name) => joinFilePath(directory, name))));
      setTreeRefreshKey((key) => key + 1);
    }
  }, []);

  const performUpload = useCallback(async (
    files: File[],
    strategy: UploadConflictStrategy,
    directory: string,
  ) => {
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    try {
      const { status, data } = await uploadFiles(directory, files, strategy, setUploadProgress);
      if (status === 409 && data.conflicts?.length) {
        setPendingConflict({
          directory,
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }
      if (status < 200 || status >= 300) {
        throw new Error(data.error ?? `Upload failed (HTTP ${status})`);
      }
      setUploadProgress(100);
      applyUploadResult(data, directory);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [applyUploadResult]);

  const prepareUpload = useCallback(async (files: File[], directory: string) => {
    if (files.length === 0 || uploadBusy) return;
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("checking");

    try {
      const res = await fetch(
        `/api/files/${encodeFilePathForApi(directory)}?type=upload-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileNames: files.map((file) => file.name) }),
        },
      );
      const data = await res.json().catch(() => ({})) as UploadResponse;
      if (!res.ok) throw new Error(data.error ?? `Upload check failed (HTTP ${res.status})`);

      if (data.conflicts?.length) {
        setPendingConflict({
          directory,
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }

      await performUpload(files, "error", directory);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [performUpload, uploadBusy]);

  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void prepareUpload(files, cwd);
  }, [cwd, prepareUpload]);

  useImperativeHandle(ref, () => ({
    openUploadPicker() {
      if (!uploadBusy) uploadInputRef.current?.click();
    },
  }), [uploadBusy]);

  useEffect(() => {
    onUploadBusyChange?.(uploadBusy);
  }, [onUploadBusyChange, uploadBusy]);

  useEffect(() => () => onUploadBusyChange?.(false), [onUploadBusyChange]);

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Reset expanded state only when cwd changes, not on refreshKey bumps
    if (cwdChanged) {
      setExpandedPaths(new Set());
      setHighlightedPaths(new Set());
      setUploadSummary(null);
      setPendingConflict(null);
      setUploadError(null);
    }

    setLoading(cwdChanged);
    setError(null);
    let cancelled = false;
    fetchEntries(cwd, showHidden)
      .then((entries) => { if (!cancelled) setRoots(entries); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey, showHidden]);

  useEffect(() => {
    let cancelled = false;
    fetchGitStatus(cwd)
      .then((status) => {
        if (!cancelled) {
          setGitFiles(status.isGitRepository ? status.files : []);
          setGitLineStats(status.isGitRepository
            ? { additions: status.additions, deletions: status.deletions }
            : { additions: 0, deletions: 0 });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGitFiles([]);
          setGitLineStats({ additions: 0, deletions: 0 });
        }
      });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey]);

  useEffect(() => {
    onChangesCountChange?.(gitFiles.length);
  }, [gitFiles, onChangesCountChange]);

  // Read after mount: the server render has no storage.
  useEffect(() => {
    setChangesViewMode(loadChangesViewMode());
  }, []);

  const changesByRelativePath = useMemo(() => new Map(gitFiles.map((status) => [
    normalizeFilePathSlashes(getRelativeFilePath(status.filePath, cwd)).replace(/^\/+/, ""),
    status,
  ])), [cwd, gitFiles]);
  const changesTree = useMemo(() => buildSearchTree([...changesByRelativePath.keys()]), [changesByRelativePath]);

  const handleToggleChangesExpanded = useCallback((path: string, open: boolean) => {
    setCollapsedChangeDirs((prev) => {
      const next = new Set(prev);
      if (open) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const handleChangesViewModeToggle = useCallback(() => {
    setChangesViewMode((prev) => {
      const next: ChangesViewMode = prev === "list" ? "tree" : "list";
      setPref(APP_PREF_KEYS.changesViewMode, next);
      return next;
    });
  }, []);

  // F4: a file drag over the panel. Folder rows claim it (dropTargetPath);
  // the panel background means the project root.
  const fileDragDepthRef = useRef(0);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

  const resetFileDrag = useCallback(() => {
    fileDragDepthRef.current = 0;
    setFileDragActive(false);
    setDropTargetPath(null);
  }, []);

  const handleExplorerDragEnter = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    fileDragDepthRef.current += 1;
    setFileDragActive(true);
  }, []);

  const handleExplorerDragOver = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    // Folder rows stop dragover propagation, so this runs only over the
    // panel background: those uploads go to the project root.
    setDropTargetPath((prev) => (prev === null ? prev : null));
  }, []);

  const handleExplorerDragLeave = useCallback(() => {
    if (fileDragDepthRef.current <= 0) return;
    fileDragDepthRef.current -= 1;
    if (fileDragDepthRef.current === 0) {
      setFileDragActive(false);
      setDropTargetPath(null);
    }
  }, []);

  const handleDropFiles = useCallback((directory: string, items: DroppedItem[]) => {
    resetFileDrag();
    // The endpoint writes files only: a dropped folder would fail the whole
    // upload, so folders are left out with the chat drop's notice.
    const files = items.flatMap((item) => (item.kind === "file" ? [item.file] : []));
    const folders = items.flatMap((item) => (item.kind === "folder" ? [item.name] : []));
    void prepareUpload(files, directory).then(() => {
      if (folders.length === 0) return;
      const notice = t("chat.dropFoldersUnsupported", { names: folders.join(", ") });
      // An error from this upload says why its files did not land: keep it.
      setUploadError((error) => (error && files.length > 0 ? error : notice));
    });
  }, [prepareUpload, resetFileDrag, t]);

  const handleExplorerDrop = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    handleDropFiles(dropTargetPath ?? cwd, droppedItems(event.dataTransfer));
  }, [cwd, dropTargetPath, handleDropFiles]);

  const handleDropTargetChange = useCallback((path: string | null) => {
    setDropTargetPath((prev) => (prev === path ? prev : path));
  }, []);

  const showUploadFeedback = uploadBusy || pendingConflict !== null || uploadError !== null || uploadSummary !== null;

  const addUploadedFilesToChat = useCallback(() => {
    if (!uploadSummary || uploadSummary.uploaded.length === 0) return;
    onAtMentions?.(
      uploadSummary.uploaded.map((name) => getRelativeFilePath(joinFilePath(uploadSummary.directory, name), cwd)),
    );
  }, [cwd, onAtMentions, uploadSummary]);

  return (
    <div
      style={{ minHeight: "100%" }}
      onDragEnter={handleExplorerDragEnter}
      onDragOver={handleExplorerDragOver}
      onDragLeave={handleExplorerDragLeave}
      onDrop={handleExplorerDrop}
    >
      <input ref={uploadInputRef} type="file" multiple hidden onChange={handleUploadInput} />
      {showUploadFeedback && (
        <div style={{ padding: "6px 8px", borderBottom: "var(--hairline) solid var(--border)" }}>
        {uploadBusy && (
          <div role="status" aria-live="polite" aria-label={uploadPhase === "checking" ? t("files.checking") : t("files.uploading", { progress: uploadProgress })}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 14, color: "var(--text-muted)" }}>
              {uploadPhase === "checking" ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-5.7-8.4" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 16V4" />
                  <path d="m7 9 5-5 5 5" />
                  <path d="M5 20h14" />
                </svg>
              )}
              {uploadPhase === "uploading" && <span style={{ fontSize: "var(--fs-micro)" }}>{uploadProgress}%</span>}
            </div>
            {uploadPhase === "uploading" && (
              <div style={{ height: 3, marginTop: 4, overflow: "hidden", borderRadius: 2, background: "var(--border)" }}>
                <div style={{ width: `${uploadProgress}%`, height: "100%", background: "var(--text-muted)", transition: "width var(--dur-fast) var(--ease-native)" }} />
              </div>
            )}
          </div>
        )}

        {pendingConflict && (
          <div role="alert" style={{ padding: 7, border: "var(--hairline) solid color-mix(in srgb, var(--warning) 55%, var(--border))", borderRadius: "var(--radius-xs)", background: "color-mix(in srgb, var(--warning) 9%, var(--bg-panel))" }}>
            <div style={{ fontSize: "var(--fs-micro)", color: "var(--text)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {t("files.conflictSummary", { count: pendingConflict.conflicts.length, countSuffix: pendingConflict.conflicts.length === 1 ? "" : "s", files: pendingConflict.conflicts.join(", ") })}
            </div>
            {pendingConflict.nonReplaceable.length > 0 && (
              <div style={{ marginTop: 3, fontSize: "var(--fs-micro)", color: "var(--warning)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                {t("files.cannotReplace", { files: pendingConflict.nonReplaceable.join(", ") })}
              </div>
            )}
            <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "overwrite", pendingConflict.directory)} style={{ height: 22, padding: "0 7px", border: "var(--hairline) solid var(--danger)", borderRadius: "var(--radius-xs)", background: "transparent", color: "var(--danger)", cursor: "pointer", fontSize: "var(--fs-micro)" }}>
                {t("files.replace")}
              </button>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "skip", pendingConflict.directory)} style={{ height: 22, padding: "0 7px", border: "var(--hairline) solid var(--border)", borderRadius: "var(--radius-xs)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: "var(--fs-micro)" }}>
                {t("files.skipExisting")}
              </button>
              <button type="button" onClick={() => setPendingConflict(null)} style={{ height: 22, padding: "0 7px", border: "none", borderRadius: "var(--radius-xs)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: "var(--fs-micro)" }}>
                {t("files.cancel")}
              </button>
            </div>
          </div>
        )}

        {uploadError && (
          <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: "var(--fs-micro)", lineHeight: 1.35, color: "var(--danger)" }}>
            <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{uploadError}</span>
            <DismissButton onClick={() => setUploadError(null)} title={t("files.dismissError")} />
          </div>
        )}

        {uploadSummary && (
          <div aria-live="polite">
            <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 22, fontSize: "var(--fs-micro)" }}>
              <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                {uploadSummary.uploaded.length > 0 && (
                  <span title={`${uploadSummary.uploaded.length} uploaded`} aria-label={`${uploadSummary.uploaded.length} uploaded`} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--success)" }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                    <span>{uploadSummary.uploaded.length}</span>
                  </span>
                )}
                {uploadSummary.skipped.length > 0 && (
                  <span title={`${uploadSummary.skipped.length} skipped`} aria-label={`${uploadSummary.skipped.length} skipped`} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-dim)" }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M8 12h8" />
                    </svg>
                    <span>{uploadSummary.skipped.length}</span>
                  </span>
                )}
                {uploadSummary.errors.length > 0 && (
                  <span title={`${uploadSummary.errors.length} failed`} aria-label={`${uploadSummary.errors.length} failed`} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--danger)" }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3 2.5 20h19L12 3Z" />
                      <path d="M12 9v4" />
                      <path d="M12 17h.01" />
                    </svg>
                    <span>{uploadSummary.errors.length}</span>
                  </span>
                )}
              </div>
              {uploadSummary.uploaded.length > 0 && onAtMentions && (
                <button
                  type="button"
                  onClick={addUploadedFilesToChat}
                  title={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  aria-label={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  style={{ height: 22, padding: "0 7px", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, flexShrink: 0, border: "var(--hairline) solid var(--border)", borderRadius: "var(--radius-xs)", background: "var(--bg-panel)", color: "var(--accent)", cursor: "pointer", fontSize: "var(--fs-micro)", fontWeight: "var(--fw-semibold)", whiteSpace: "nowrap" }}
                >
                  <MentionIcon />
                  {t("files.mention")}
                </button>
              )}
              <DismissButton onClick={() => setUploadSummary(null)} title={t("files.dismissUploadResults")} />
            </div>
            {uploadSummary.errors.map((item) => (
              <div key={item.name} title={item.error} style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, minWidth: 0, fontSize: "var(--fs-micro)", color: "var(--danger)" }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5" />
                  <path d="M12 17h.01" />
                </svg>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
              </div>
            ))}
          </div>
        )}
        </div>
      )}

      {fileSearchOpen && (
      <div style={{ padding: "6px 8px", borderBottom: "var(--hairline) solid var(--border)" }}>
        <div style={{ position: "relative" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", pointerEvents: "none" }}>
            <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
          </svg>
          <input
            ref={searchInputRef}
            id="file-search-input"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape" && !isImeComposing(event)) onFileSearchOpenChange?.(false); }}
            placeholder={t("sidebar.searchFilesPlaceholder")}
            aria-label={t("sidebar.searchFiles")}
            style={{ width: "100%", boxSizing: "border-box", padding: "6px 24px", border: "var(--hairline) solid var(--border)", borderRadius: "var(--radius-sm)", outline: "none", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)" }}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              title={t("sidebar.clearSearch")}
              aria-label={t("sidebar.clearSearch")}
              style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", display: "flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, padding: 0, border: "none", borderRadius: "var(--radius-xs)", background: "none", color: "var(--text-dim)", cursor: "pointer" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6 6 18" /><path d="m6 6 12 12" />
              </svg>
            </button>
          )}
        </div>
        {hasSearchQuery && (
          <div style={{ paddingTop: 3 }}>
            {searchLoading && <div role="status" style={{ padding: "6px 2px", fontSize: "var(--fs-micro)", color: "var(--text-dim)" }}>{t("sidebar.searchingFiles")}</div>}
            {!searchLoading && searchError && <div role="alert" style={{ padding: "6px 2px", fontSize: "var(--fs-micro)", color: "var(--danger)" }}>{t("i18n.networkError")}</div>}
            {!searchLoading && !searchError && searchPaths.length === 0 && <div style={{ padding: "6px 2px", fontSize: "var(--fs-micro)", color: "var(--text-dim)" }}>{t("sidebar.noMatchingFiles")}</div>}
            {!searchLoading && !searchError && searchPaths.length > 0 && (
              <div>
                {searchRoots.map((node) => (
                  <TreeNode
                    key={`${searchQuery}:${node.fullPath}`}
                    node={node}
                    depth={0}
                    cwd={cwd}
                    onOpenFile={onOpenFile}
                    onAtMention={onAtMention}
                    expandedPaths={searchExpanded}
                    onToggleExpanded={(fullPath, open) => {
                      setSearchExpanded((prev) => {
                        const next = new Set(prev);
                        if (open) next.add(fullPath); else next.delete(fullPath);
                        return next;
                      });
                    }}
                    highlightedPaths={highlightedPaths}
                    gitStatusByPath={gitStatusByPath}
                    changedDirectoryPaths={changedDirectoryPaths}
                    t={t}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {!changesCollapsed && gitFiles.length > 0 && (
        <div style={{ padding: "0 4px 2px" }}>
          <div
            aria-label={t("files.changeStats", {
              count: gitFiles.length,
              additions: gitLineStats.additions,
              deletions: gitLineStats.deletions,
            })}
            style={{ display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 6px 0 10px", fontSize: "var(--fs-caption)" }}
          >
            <span style={{ color: "var(--text-dim)" }}>
              {t("files.changedCount", { count: gitFiles.length })}
            </span>
            <span style={{ color: GIT_STATUS_COLORS.added, fontFamily: "var(--font-mono)" }}>+{gitLineStats.additions}</span>
            <span style={{ color: GIT_STATUS_COLORS.deleted, fontFamily: "var(--font-mono)" }}>-{gitLineStats.deletions}</span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="file-changes-view-toggle"
              onClick={handleChangesViewModeToggle}
              title={changesViewMode === "list" ? t("files.viewAsTree") : t("files.viewAsList")}
              aria-label={changesViewMode === "list" ? t("files.viewAsTree") : t("files.viewAsList")}
              aria-pressed={changesViewMode === "tree"}
            >
              <ChangesViewToggleIcon mode={changesViewMode} />
            </button>
          </div>
          {changesViewMode === "tree" ? (
            <ChangesTreeRows
              nodes={changesTree}
              depth={0}
              cwd={cwd}
              statusByPath={changesByRelativePath}
              collapsedPaths={collapsedChangeDirs}
              onToggleExpanded={handleToggleChangesExpanded}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              t={t}
            />
          ) : (
            gitFiles.map((status) => (
              <ChangeRow
                key={status.filePath}
                status={status}
                cwd={cwd}
                onOpenFile={onOpenFile}
                onAtMention={onAtMention}
                t={t}
              />
            ))
          )}
        </div>
      )}

      {(changesCollapsed || gitFiles.length === 0) && (!fileSearchOpen || !hasSearchQuery) && (
        <div style={{ padding: "2px 4px" }}>
          {loading ? (
            <div className="file-tree-loading" role="status" aria-label={t("files.loading")}>
              {[0, 1, 2, 3, 4, 5].map((item) => (
                <span key={item} style={{ "--skeleton-width": `${64 + ((item * 17) % 30)}%` } as CSSProperties} />
              ))}
            </div>
          ) : error ? (
            <div className="file-tree-message is-error" role="alert">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => {
                  setLoading(true);
                  setTreeRefreshKey((value) => value + 1);
                }}
              >
                {t("common.retry")}
              </button>
            </div>
          ) : (
            roots.map((node) => (
              <TreeNode
                key={node.fullPath}
                node={node}
                depth={0}
                cwd={cwd}
                onOpenFile={onOpenFile}
                onAtMention={onAtMention}
                expandedPaths={expandedPaths}
                onToggleExpanded={handleToggleExpanded}
                refreshToken={refreshToken}
                highlightedPaths={highlightedPaths}
                gitStatusByPath={gitStatusByPath}
                changedDirectoryPaths={changedDirectoryPaths}
                showHidden={showHidden}
                dropTargetPath={dropTargetPath}
                onDropFiles={handleDropFiles}
                onDropTargetChange={handleDropTargetChange}
                t={t}
              />
            ))
          )}
          {!loading && !error && roots.length === 0 && (
            <div style={{ padding: "8px 12px", fontSize: "var(--fs-micro)", color: "var(--text-dim)" }}>
              {t("files.noFiles")}
            </div>
          )}
        </div>
      )}
      {/* Last, pinned to the bottom: at the top it pushed every row down as
          a drag came in, so the row under the pointer changed. Drags pass
          through it to the row it covers. */}
      {fileDragActive && (
        <div role="status" aria-live="polite" className="file-tree-drop-hint">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path d="M12 16V4" />
            <path d="m7 9 5-5 5 5" />
            <path d="M5 20h14" />
          </svg>
          {t("files.dropToUpload", {
            directory: dropTargetPath
              ? (getRelativeFilePath(dropTargetPath, cwd) || dropTargetPath)
              : (getFileName(cwd) || cwd),
          })}
        </div>
      )}
    </div>
  );
});
