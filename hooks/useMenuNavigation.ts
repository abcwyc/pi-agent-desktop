"use client";

import { useEffect, useRef, type RefObject } from "react";
import { isImeComposing } from "@/lib/ime";

/** Keyboard behavior shared by action menus and simple option lists. */
export function useMenuNavigation(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    const panel = container?.querySelector<HTMLElement>('[role="menu"], [role="listbox"]') ?? container;
    if (!panel) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => Array.from(panel.querySelectorAll<HTMLButtonElement>(
      'button[role="menuitem"]:not(:disabled), button[role="menuitemcheckbox"]:not(:disabled), button[role="menuitemradio"]:not(:disabled), button[role="option"]:not(:disabled)',
    ));
    const buttons = items();
    const selected = buttons.find((button) => button.getAttribute("aria-selected") === "true" || button.getAttribute("aria-checked") === "true");
    (selected ?? buttons[0])?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeComposing(event)) return;
      const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
      if (keys.includes(event.key)) {
        event.preventDefault();
        const rows = items();
        const index = rows.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
          : index < 0 ? (event.key === "ArrowUp" ? rows.length - 1 : 0)
          : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
        rows[next]?.focus({ preventScroll: true });
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        // Let the browser move focus before removing the menu.
        window.setTimeout(() => closeRef.current(), 0);
      }
    };
    panel.addEventListener("keydown", onKeyDown);
    return () => {
      panel.removeEventListener("keydown", onKeyDown);
      if (trigger?.isConnected && (panel.contains(document.activeElement) || document.activeElement === document.body)) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, [open, containerRef]);
}
