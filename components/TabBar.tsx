"use client";

import { useEffect, useRef, useState } from "react";
import { getFileIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";
import type { FileViewerDisplayMode, FileViewerState } from "@/lib/file-viewer-state";

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  /** "side": a side chat opened beside the main chat (C1). */
  kind?: "terminal" | "artifact" | "side";
  closing?: boolean;
  sourceSessionId?: string | null;
  initialDisplayMode?: FileViewerDisplayMode;
  /** PDF page requested by the link that opened this tab (`#page=N`). */
  page?: number;
  viewerState?: FileViewerState;
  viewerRevision?: number;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTerminal?: () => void;
  /** A2: drop `source` before or after `target`; tabs drag only when it is set. */
  onReorderTab?: (source: string, target: string, after: boolean) => void;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onNewTerminal, onReorderTab }: Props) {
  const { t } = useI18n();
  const barRef = useRef<HTMLDivElement>(null);
  const draggedId = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);

  // Flag which edges have tabs scrolled past them; the CSS turns each flag
  // into a fade, so a tab sliding under the chips beside the bar dissolves
  // instead of being cut off at a hard edge.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const update = () => {
      const max = bar.scrollWidth - bar.clientWidth;
      bar.toggleAttribute("data-overflow-start", bar.scrollLeft > 1);
      bar.toggleAttribute("data-overflow-end", bar.scrollLeft < max - 1);
    };
    update();
    bar.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    for (const child of Array.from(bar.children)) observer.observe(child);
    return () => {
      bar.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [tabs]);

  // The scrollbar is hidden, so a newly opened or activated tab would otherwise
  // stay out of sight past the edge.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || !activeTabId) return;
    const tab = Array.from(bar.querySelectorAll<HTMLElement>("[data-tab-id]"))
      .find((element) => element.dataset.tabId === activeTabId);
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

  // A plain mouse wheel only scrolls vertically; map it onto the row.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      if (bar.scrollWidth <= bar.clientWidth) return;
      event.preventDefault();
      bar.scrollBy({ left: event.deltaY, behavior: "instant" });
    };
    bar.addEventListener("wheel", onWheel, { passive: false });
    return () => bar.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div ref={barRef} className="file-tab-bar" role="tablist" aria-label="Open files">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`file-tab${isActive ? " is-active" : ""}${dropTarget?.id === tab.id ? (dropTarget.after ? " is-drop-after" : " is-drop-before") : ""}`}
            role="tab"
            aria-label={tab.kind === "terminal" ? t("terminal.tabLabel", { name: tab.label }) : tab.kind === "side" ? `${t("sideChat.tabLabel")}: ${tab.label}` : tab.label}
            aria-selected={isActive}
            tabIndex={isActive || (!activeTabId && tabs[0].id === tab.id) ? 0 : -1}
            data-tab-id={tab.id}
            title={tab.filePath}
            draggable={Boolean(onReorderTab)}
            onDragStart={(event) => {
              if (!onReorderTab) return;
              draggedId.current = tab.id;
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", tab.id);
            }}
            onDragOver={(event) => {
              if (!draggedId.current || draggedId.current === tab.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const rect = event.currentTarget.getBoundingClientRect();
              const after = event.clientX >= rect.left + rect.width / 2;
              setDropTarget((prev) => prev?.id === tab.id && prev.after === after ? prev : { id: tab.id, after });
            }}
            onDrop={(event) => {
              if (!draggedId.current || draggedId.current === tab.id) return;
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              onReorderTab?.(draggedId.current, tab.id, event.clientX >= rect.left + rect.width / 2);
              draggedId.current = null;
              setDropTarget(null);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setDropTarget((prev) => prev?.id === tab.id ? null : prev);
            }}
            onDragEnd={() => { draggedId.current = null; setDropTarget(null); }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectTab(tab.id);
              } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const index = tabs.findIndex((item) => item.id === tab.id);
                const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
                  : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                onSelectTab(tabs[next].id);
                (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
              }
            }}
            onClick={() => onSelectTab(tab.id)}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              event.stopPropagation();
              onCloseTab(tab.id);
            }}
          >
            <span className="file-tab-icon">
              {tab.kind === "terminal" ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              ) : tab.kind === "side" ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 12a8 8 0 0 1-8 8H5.5a2 2 0 0 1-1.4-3.4A8 8 0 1 1 21 12z" />
                </svg>
              ) : tab.kind === "artifact" ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3 3 8l9 5 9-5-9-5Z" /><path d="m3 13 9 5 9-5" />
                </svg>
              ) : getFileIcon(tab.label, 13)}
            </span>
            <span className="file-tab-label" title={tab.filePath}>
              {tab.label}
            </span>
            <button
              className="file-tab-close"
              draggable={false}
              onDragStart={(event) => event.stopPropagation()}
              disabled={tab.closing}
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              title={t(tab.kind === "terminal" ? "terminal.close" : "i18n.close")}
              aria-label={`${t(tab.kind === "terminal" ? "terminal.close" : "i18n.close")} ${tab.label}`}
            >
              <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        );
      })}
      {onNewTerminal && (
        <div className="file-tab-add-anchor">
          <button
            type="button"
            className="file-tab-add"
            onClick={onNewTerminal}
            title={t("terminal.newTerminal")}
            aria-label={t("terminal.newTerminal")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
