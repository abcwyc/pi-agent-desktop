"use client";

// Fork-owned: the menu behind the sidebar header's settings button, listing the
// settings sections (a native popup in the desktop shell, a DOM menu otherwise).
// AppShell (upstream-owned) keeps the button and mounts the menu.

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { canUseNativeMenu, menuPointBelow, showNativeMenu } from "@/lib/desktop-menu";
import { isImeComposing } from "@/lib/ime";
import type { SettingsSection } from "@/lib/settings-navigation";
import { useMenuNavigation } from "@/hooks/useMenuNavigation";
import { useI18n } from "@/hooks/useI18n";
import { SETTINGS_SECTION_ITEMS, SettingsSectionIcon } from "./SettingsPanel";

export function useSettingsEntryMenu(onSelectSection: (section: SettingsSection) => void) {
  const { t: translate } = useI18n();
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [settingsMenuPos, setSettingsMenuPos] = useState<{ top: number; left: number } | null>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const settingsMenuButtonRef = useRef<HTMLButtonElement>(null);
  const closeSettingsMenu = useCallback(() => {
    setSettingsMenuOpen(false);
    setSettingsMenuPos(null);
  }, []);
  useEffect(() => {
    if (!settingsMenuOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (settingsMenuRef.current?.contains(target)) return;
      // Clicks on the toggle button fall through to its onClick, which closes.
      if (settingsMenuButtonRef.current?.contains(target)) return;
      closeSettingsMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !isImeComposing(event)) closeSettingsMenu();
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [settingsMenuOpen, closeSettingsMenu]);

  /** `hasProject`: sections that need a project are offered only with one. */
  const toggleSettingsMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>, hasProject: boolean) => {
    if (settingsMenuOpen) {
      closeSettingsMenu();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const openDomMenu = () => {
      const menuWidth = 184;
      const menuHeight = 236;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
      const below = rect.bottom + 6;
      const top = below + menuHeight > window.innerHeight - 8
        ? Math.max(8, rect.top - menuHeight - 6)
        : below;
      setSettingsMenuPos({ top, left });
      setSettingsMenuOpen(true);
    };
    // Desktop shell with native popups on: the same section list as a native
    // menu, shown by the shell (`show_popup_menu`). The DOM menu is the
    // fallback when it cannot be shown, and the menu in regular builds.
    if (canUseNativeMenu()) {
      void showNativeMenu(
        SETTINGS_SECTION_ITEMS.map((item) => ({
          label: translate(item.labelKey),
          disabled: item.requiresProject && !hasProject,
          onSelect: () => onSelectSection(item.id),
        })),
        menuPointBelow(event.currentTarget),
      ).then((shown) => { if (!shown) openDomMenu(); });
      return;
    }
    openDomMenu();
  }, [settingsMenuOpen, closeSettingsMenu, translate, onSelectSection]);

  return { settingsMenuOpen, settingsMenuPos, settingsMenuRef, settingsMenuButtonRef, closeSettingsMenu, toggleSettingsMenu };
}

interface SettingsEntryMenuProps {
  menu: ReturnType<typeof useSettingsEntryMenu>;
  hasProject: boolean;
  onSelectSection: (section: SettingsSection) => void;
}

export function SettingsEntryMenu({ menu, hasProject, onSelectSection }: SettingsEntryMenuProps) {
  const { t: translate } = useI18n();
  const { settingsMenuOpen, settingsMenuPos, settingsMenuRef, closeSettingsMenu } = menu;
  useMenuNavigation(settingsMenuOpen && Boolean(settingsMenuPos), settingsMenuRef, closeSettingsMenu);
  if (!settingsMenuOpen || !settingsMenuPos) return null;
  return createPortal(
    <div
      ref={settingsMenuRef}
      className="sidebar-project-context-menu settings-entry-menu native-popover app-menu"
      style={{ top: settingsMenuPos.top, left: settingsMenuPos.left }}
      role="menu"
      aria-label={translate("common.settings")}
    >
      {SETTINGS_SECTION_ITEMS.map((item) => {
        const label = translate(item.labelKey);
        const disabled = item.requiresProject && !hasProject;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={disabled}
            title={disabled ? translate("settings.projectRequired") : label}
            onClick={() => {
              closeSettingsMenu();
              onSelectSection(item.id);
            }}
          >
            <SettingsSectionIcon section={item.id} size={14} strokeWidth={2} />
            <span>{label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
