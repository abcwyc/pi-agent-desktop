"use client";

import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useMenuNavigation } from "@/hooks/useMenuNavigation";

interface ChatsSectionMenuProps {
  menuRef: RefObject<HTMLDivElement | null>;
  pos: { top: number; left: number };
  canCollapse: boolean;
  canExpand: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  onClose?: () => void;
}

/** The Chats header's "…" menu: fold or unfold the section, like Projects' collapse-all. */
export function ChatsSectionMenu({
  menuRef,
  pos,
  canCollapse,
  canExpand,
  onCollapse,
  onExpand,
  onClose = () => {},
}: ChatsSectionMenuProps) {
  const { t } = useI18n();
  useMenuNavigation(true, menuRef, onClose);

  return createPortal(
    <div
      ref={menuRef}
      className="project-view-menu native-popover app-menu"
      role="menu"
      aria-label={t("sidebar.chatsMenu")}
      style={{ top: pos.top, left: pos.left }}
    >
      <button type="button" role="menuitem" disabled={!canCollapse} onClick={onCollapse}>
        {t("sidebar.collapseChats")}
      </button>
      <button type="button" role="menuitem" disabled={!canExpand} onClick={onExpand}>
        {t("sidebar.expandChats")}
      </button>
    </div>,
    document.body,
  );
}
