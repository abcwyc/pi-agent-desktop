"use client";

// Fork-owned: the project chip at the composer's left edge, which keeps the session's
// project visible and switches a new-session composer between active projects.
// ChatInput (upstream-owned) keeps the open state and ref (its outside-click
// handler closes every composer menu) and mounts this.

import type { Dispatch, RefObject, SetStateAction } from "react";
import { canUseNativeMenu, menuPointBelow, showNativeMenu } from "@/lib/desktop-menu";
import { getProjectDisplayName } from "@/lib/project-display";
import { useI18n } from "@/hooks/useI18n";

export function getProjectLabel(
  projectPath: string | null | undefined,
  allProjectPaths: readonly string[] = [],
): string | null {
  if (!projectPath) return null;
  return getProjectDisplayName(projectPath, allProjectPaths);
}

interface ComposerProjectChipProps {
  menuRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  onOpenChange: Dispatch<SetStateAction<boolean>>;
  label: string;
  projectPath?: string | null;
  maxWidth: number;
  /** Active project roots a new-session composer can switch between. */
  projectOptions: string[];
  onProjectChange?: (projectRoot: string) => void;
  /** Opens the project chooser when there is no list to switch within. */
  onSelectProject?: () => void;
}

export function ComposerProjectChip({
  menuRef, open, onOpenChange, label, projectPath, maxWidth, projectOptions, onProjectChange, onSelectProject,
}: ComposerProjectChipProps) {
  const { t } = useI18n();
  return (
    <div ref={menuRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        className="chat-project-context"
        style={{ maxWidth }}
        title={`${t("chat.switchProject")} · ${t("chat.currentProject", { path: projectPath ?? label })}`}
        aria-label={t("chat.currentProject", { path: projectPath ?? label })}
        aria-haspopup={projectOptions.length > 0 && onProjectChange ? "menu" : undefined}
        aria-expanded={projectOptions.length > 0 && onProjectChange ? open : undefined}
        onClick={(event) => {
          if (projectOptions.length > 0 && onProjectChange) {
            // Desktop shell: the project list as a native popup.
            if (canUseNativeMenu()) {
              void showNativeMenu(
                projectOptions.map((projectRoot) => ({
                  label: getProjectLabel(projectRoot, projectOptions) ?? projectRoot,
                  checked: projectRoot === projectPath,
                  onSelect: () => {
                    if (projectRoot !== projectPath) onProjectChange(projectRoot);
                  },
                })),
                menuPointBelow(event.currentTarget),
              ).then((shown) => { if (!shown) onOpenChange(true); });
              return;
            }
            onOpenChange((isOpen) => !isOpen);
          } else onSelectProject?.();
        }}
        disabled={!onSelectProject && !(projectOptions.length > 0 && onProjectChange)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
        <span>{label}</span>
      </button>
      {open && projectOptions.length > 0 && onProjectChange && (
        <div
          className="native-popover app-menu"
          role="menu"
          style={{
            position: "absolute",
            left: 0,
            bottom: "calc(100% + 6px)",
            zIndex: 500,
            minWidth: 220,
            maxWidth: 320,
            padding: 5,
          }}
        >
          {projectOptions.map((projectRoot) => {
            const optionLabel = getProjectLabel(projectRoot, projectOptions) ?? projectRoot;
            const isCurrent = projectRoot === projectPath;
            return (
              <button
                key={projectRoot}
                type="button"
                role="menuitem"
                aria-current={isCurrent ? "true" : undefined}
                onClick={() => {
                  onOpenChange(false);
                  if (!isCurrent) onProjectChange(projectRoot);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  minWidth: 0,
                  padding: "7px 9px",
                  border: 0,
                  borderRadius: 6,
                  background: isCurrent ? "var(--bg-selected)" : "transparent",
                  color: isCurrent ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 12,
                }}
                onMouseEnter={(e) => {
                  if (!isCurrent) e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!isCurrent) e.currentTarget.style.background = "transparent";
                }}
                title={projectRoot}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                </svg>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{optionLabel}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
