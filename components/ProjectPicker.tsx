"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DirectoryPicker } from "./DirectoryPicker";
import { AnimatedDropdown, PathLabel, displayCwd } from "./path-ui";
import { selectDirectoryNative } from "@/lib/desktop-window";

interface ProjectPickerProps {
  recentProjects: string[];
  selectedCwd: string | null;
  selectedProject: string | null;
  homeDir: string;
  /**
   * `source` is "create" when the cwd came from the New Folder flow, so the
   * host can drop the user straight into a fresh session there.
   */
  onSelectCwd: (cwd: string, source?: "pick" | "create") => void;
  /**
   * "block" fills its container (sidebar empty state); "inline" is a compact
   * toolbar trigger. "panel" renders the rows statically instead of in the
   * absolutely-positioned popover — required inside small modal shells whose
   * `overflow: hidden` would clip the popover down to its top sliver.
   */
  variant?: "block" | "inline" | "panel";
  disabled?: boolean;
}

/**
 * Project/folder picker: a trigger button showing the current folder plus a
 * dropdown to switch to a recent project, browse for a custom path, or use
 * the default directory. Self-contained so it can render both as the sidebar's
 * initial "pick a project" entry point and inline in the chat composer once a
 * project is active.
 */
/** Max entries listed before the filter box becomes the way to reach the rest. */
const MAX_VISIBLE_PROJECTS = 7;

/**
 * The unfiltered list stays capped so the dropdown reads as a short shortcut
 * list, but the cap alone would make every project past it unreachable, so
 * anything over the cap also gets a filter box. Filtering therefore has to
 * search the *whole* list and return every match (the list scrolls).
 */
export function selectVisibleProjects(
  recentProjects: string[],
  selectedProject: string | null,
  filter: string,
): string[] {
  const needle = filter.trim().toLowerCase();
  if (needle) {
    return recentProjects.filter((p) => p.toLowerCase().includes(needle));
  }
  const capped = recentProjects.slice(0, MAX_VISIBLE_PROJECTS);
  // Keep the selected project visible even when it falls outside the cap so
  // the checkmark row never disappears.
  if (selectedProject && recentProjects.includes(selectedProject) && !capped.includes(selectedProject)) {
    return [...capped.slice(0, MAX_VISIBLE_PROJECTS - 1), selectedProject];
  }
  return capped;
}

export function shouldShowProjectFilter(recentProjects: string[]): boolean {
  return recentProjects.length > MAX_VISIBLE_PROJECTS;
}

/** Open the desktop folder dialog and return the server-validated project path. */
export async function selectProjectDirectoryNative(selectedCwd: string | null, homeDir: string): Promise<string | null> {
  const path = await selectDirectoryNative(selectedCwd ?? (homeDir || undefined));
  if (path === null) return null;

  const res = await fetch("/api/cwd/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: path }),
  });
  const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data.cwd ?? path;
}

export function ProjectPicker({ recentProjects, selectedCwd, selectedProject, homeDir, onSelectCwd, variant = "block", disabled }: ProjectPickerProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownRect, setDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [projectFilter, setProjectFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [newFolderBrowseOpen, setNewFolderBrowseOpen] = useState(false);
  const [newFolderBusy, setNewFolderBusy] = useState(false);
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const closeDropdown = useCallback(() => {
    setDropdownOpen(false);
    setProjectFilter("");
    setCustomPathOpen(false);
    setCustomPathError(null);
    setNewFolderBrowseOpen(false);
    setNewFolderError(null);
  }, []);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (customPathOpen || newFolderBrowseOpen) return;
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        closeDropdown();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen, closeDropdown, customPathOpen, newFolderBrowseOpen]);

  const commitCustomPath = useCallback(async (candidate: string): Promise<boolean> => {
    const path = candidate.trim();
    if (!path || customPathValidating) return false;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!res.ok || data.error) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return false;
      }
      onSelectCwd(data.cwd ?? path);
      closeDropdown();
      return true;
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValidating, onSelectCwd, closeDropdown]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathError(null);
    setCustomPathOpen(true);
    setDropdownOpen(false);
  }, []);

  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (data.cwd) {
        onSelectCwd(data.cwd);
        closeDropdown();
        return;
      }
      setCustomPathError(data.error ?? `HTTP ${res.status}`);
      setCustomPathOpen(true);
      setDropdownOpen(true);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
      setCustomPathOpen(true);
      setDropdownOpen(true);
    }
  }, [onSelectCwd, closeDropdown]);

  // Create a fresh project folder via /api/cwd/create (home-confined) and
  // hand it to the host with source "create" so a session opens right in it.
  const submitNewFolder = useCallback(async (parent: string, name: string) => {
    if (newFolderBusy) return;
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      setNewFolderError("Enter a folder name without slashes");
      return;
    }
    setNewFolderBusy(true);
    setNewFolderError(null);
    try {
      const res = await fetch("/api/cwd/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: `${parent}/${name}` }),
      });
      const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!res.ok || data.error || !data.cwd) {
        setNewFolderError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      onSelectCwd(data.cwd, "create");
      closeDropdown();
    } catch (e) {
      setNewFolderError(e instanceof Error ? e.message : String(e));
    } finally {
      setNewFolderBusy(false);
    }
  }, [newFolderBusy, onSelectCwd, closeDropdown]);

  const trimmedFilter = projectFilter.trim();
  const showProjectFilter = shouldShowProjectFilter(recentProjects);
  const visibleProjects = selectVisibleProjects(recentProjects, selectedProject, projectFilter);

  /**
   * Shared picker rows: filter box, capped project list, and the two escape
   * hatches. The popover (block/inline) and the panel variant render the same
   * body — only the scroll container differs, because a panel flexes with its
   * modal shell instead of using a fixed popover max-height.
   */
  const pickerBody = (
    <>
      {showProjectFilter && (
        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
          <input
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (projectFilter) setProjectFilter("");
                else closeDropdown();
              }
            }}
            placeholder="Filter projects…"
            aria-label="Filter projects"
            autoFocus
            style={{
              width: "100%",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              padding: "5px 8px",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              outline: "none",
            }}
          />
        </div>
      )}
      <div style={variant === "panel"
        ? { flex: 1, minHeight: 0, overflowY: "auto" }
        : { maxHeight: "min(50vh, 380px)", overflowY: "auto" }}
      >
        {visibleProjects.map((project, index) => (
          <button
            key={project}
            className="project-picker-option"
            onClick={() => {
              onSelectCwd(project);
              closeDropdown();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              width: "100%",
              padding: "8px 10px",
              background: "none",
              border: "none",
              borderBottom: index < visibleProjects.length - 1 ? "1px solid var(--border)" : "none",
              color: project === selectedProject ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer",
              textAlign: "left",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={project}
          >
            {project === selectedProject && (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <polyline points="1.5 5 4 7.5 8.5 2.5" />
              </svg>
            )}
            {project !== selectedProject && <span style={{ width: 10, flexShrink: 0 }} />}
            <PathLabel text={displayCwd(project, homeDir)} style={{ flex: 1 }} />
          </button>
        ))}
        {visibleProjects.length === 0 && trimmedFilter && (
          <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>No matching projects</div>
        )}
      </div>

      {/* Default cwd shortcut */}
      {!customPathOpen && (
        <button
          className="project-picker-option"
          onClick={(e) => { e.stopPropagation(); void handleDefaultCwd(); }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            width: "100%",
            padding: "8px 10px",
            background: "none",
            border: "none",
            borderTop: visibleProjects.length > 0 || trimmedFilter ? "1px solid var(--border)" : "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            textAlign: "left",
            fontSize: 11,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
          </svg>
          <span>Use default directory</span>
        </button>
      )}

      {/* Browse folders on the server filesystem (including WSL2 home). */}
      <button
        className="project-picker-option"
        onClick={(e) => {
          e.stopPropagation();
          void handleCustomPathClick();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          padding: "8px 10px",
          background: "none",
          border: "none",
          borderTop: "1px solid var(--border)",
          color: "var(--text-muted)",
          cursor: "pointer",
          textAlign: "left",
          fontSize: 11,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
          <line x1="5" y1="1" x2="5" y2="9" />
          <line x1="1" y1="5" x2="9" y2="5" />
        </svg>
        <span>Open Folder…</span>
      </button>
      <button
        className="project-picker-option"
        onClick={(e) => {
          e.stopPropagation();
          setNewFolderBrowseOpen(true);
          setNewFolderError(null);
        }}
        disabled={!homeDir}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          padding: "8px 10px",
          background: "none",
          border: "none",
          borderTop: "1px solid var(--border)",
          color: "var(--text-muted)",
          cursor: "pointer",
          textAlign: "left",
          fontSize: 11,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
          <line x1="5" y1="1" x2="5" y2="9" />
          <line x1="1" y1="5" x2="9" y2="5" />
        </svg>
        <span>New Folder…</span>
      </button>
      {customPathError && !customPathOpen && (
        <div
          role="alert"
          style={{
            padding: "6px 10px 8px",
            borderTop: "1px solid var(--border)",
            color: "var(--danger)",
            fontSize: 11,
            lineHeight: 1.35,
            overflowWrap: "anywhere",
          }}
        >
          {customPathError}
        </div>
      )}
    </>
  );

  const browsers = (
    <>
      {customPathOpen && (
        <DirectoryPicker
          initialPath={homeDir || undefined}
          busy={customPathValidating}
          error={customPathError}
          onCancel={() => { setCustomPathOpen(false); setCustomPathError(null); }}
          onSelect={(path) => void commitCustomPath(path)}
        />
      )}
      {newFolderBrowseOpen && homeDir && (
        <DirectoryPicker
          initialPath={homeDir}
          rootPath={homeDir}
          busy={newFolderBusy}
          error={newFolderError}
          onCancel={() => { setNewFolderBrowseOpen(false); setNewFolderError(null); }}
          onCreate={(parent, name) => void submitNewFolder(parent, name)}
        />
      )}
    </>
  );

  if (variant === "panel") {
    return (
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, width: "100%" }}>
        {pickerBody}
        {browsers}
      </div>
    );
  }

  const isInline = variant === "inline";

  const panelStyle = isInline && dropdownRect
    ? {
        position: "fixed" as const,
        bottom: window.innerHeight - dropdownRect.top + 6,
        left: dropdownRect.left,
        width: "max-content",
        minWidth: Math.max(dropdownRect.width, 260),
        maxWidth: 360,
        zIndex: 650,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 -6px 20px rgba(0,0,0,0.10)",
        overflow: "hidden",
      }
    : {
        position: "absolute" as const,
        top: "calc(100% + 4px)",
        left: 0,
        right: 0,
        zIndex: 100,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
        overflow: "hidden",
      };

  return (
    <div ref={dropdownRef} style={{ position: "relative", width: isInline ? undefined : "100%" }}>
      <button
        type="button"
        className={isInline ? "native-toolbar-button" : "sidebar-header-row"}
        disabled={disabled}
        onClick={(e) => {
          if (isInline) {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
          }
          setDropdownOpen((v) => !v);
        }}
        title={selectedProject ?? selectedCwd ?? ""}
        style={isInline ? {
          display: "flex", alignItems: "center", gap: 6,
          padding: "8px 12px",
          height: 32,
          maxWidth: 220,
          overflow: "hidden",
          background: dropdownOpen ? "var(--bg-hover)" : "none",
          border: "none",
          borderRadius: 9,
          color: "var(--text-muted)",
          cursor: disabled ? "not-allowed" : "pointer",
          fontSize: 12,
          opacity: disabled ? 0.5 : 1,
          transition: "background 0.12s, color 0.12s",
        } : {
          background: dropdownOpen ? "var(--bg-hover)" : undefined,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: isInline ? undefined : "var(--text-muted)" }}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
        </svg>
        {isInline ? (
          selectedCwd ? (
            <PathLabel
              text={displayCwd(selectedProject ?? selectedCwd, homeDir)}
              style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 12 }}
            />
          ) : (
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)" }}>
              Select project…
            </span>
          )
        ) : (
          <>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: 12.5,
                fontWeight: 500,
                color: selectedCwd ? "var(--text)" : "var(--accent)",
              }}
            >
              {selectedCwd
                ? ((selectedProject ?? selectedCwd).split("/").filter(Boolean).pop() ?? displayCwd(selectedProject ?? selectedCwd, homeDir))
                : "Select project…"}
            </span>
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="2 3.5 5 6.5 8 3.5" />
            </svg>
          </>
        )}
      </button>

      <AnimatedDropdown className="native-popover" open={dropdownOpen} style={panelStyle}>
        {pickerBody}
      </AnimatedDropdown>

      {browsers}
    </div>
  );
}
