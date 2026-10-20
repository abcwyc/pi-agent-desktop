"use client";

import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useMenuNavigation } from "@/hooks/useMenuNavigation";

export type ProjectViewMode = "grouped" | "timeline";

interface ProjectViewMenuProps {
  menuRef: RefObject<HTMLDivElement | null>;
  pos: { top: number; left: number };
  mode: ProjectViewMode;
  canCollapseAll: boolean;
  canExpandAll: boolean;
  controlsDisabled: boolean;
  onModeChange: (mode: ProjectViewMode) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onClose?: () => void;
}

/**
 * The Projects header's "…" menu. Mode choices are radio items; collapse and
 * expand remain available for the grouped tree and are disabled in timeline
 * mode, where project groups are not rendered.
 */
export function ProjectViewMenu({
  menuRef,
  pos,
  mode,
  canCollapseAll,
  canExpandAll,
  controlsDisabled,
  onModeChange,
  onCollapseAll,
  onExpandAll,
  onClose = () => {},
}: ProjectViewMenuProps) {
  const { t } = useI18n();
  useMenuNavigation(true, menuRef, onClose);

  const modeItem = (value: ProjectViewMode) => {
    const selected = mode === value;
    return (
      <button
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        className={selected ? "is-selected" : undefined}
        autoFocus={selected}
        onClick={() => onModeChange(value)}
      >
        <span>{t(value === "grouped" ? "sidebar.projectViewGrouped" : "sidebar.projectViewTimeline")}</span>
      </button>
    );
  };

  return createPortal(
    <div
      ref={menuRef}
      className="project-view-menu native-popover app-menu"
      role="menu"
      aria-label={t("sidebar.projectViewMenu")}
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="project-view-menu-heading">{t("sidebar.projectViewMode")}</div>
      {modeItem("grouped")}
      {modeItem("timeline")}
      <div className="project-view-menu-separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        disabled={controlsDisabled || !canCollapseAll}
        onClick={onCollapseAll}
      >
        {t("sidebar.collapseAllProjects")}
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={controlsDisabled || !canExpandAll}
        onClick={onExpandAll}
      >
        {t("sidebar.expandAllProjects")}
      </button>
    </div>,
    document.body,
  );
}
