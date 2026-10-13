"use client";

import { useCallback, type MouseEvent } from "react";

import { startDraggingWindow, toggleMaximizeWindow } from "@/lib/desktop-window";

import { useDesktopChrome } from "./useDesktopChrome";

const NO_DRAG_SELECTOR =
  'button, a, input, textarea, select, [role="button"], [contenteditable="true"], [data-no-drag]';

/** Element with just enough DOM API to test the drag decision without a browser. */
interface ClosestTarget {
  closest(selector: string): unknown;
}

/**
 * True when `target` sits inside a `data-tauri-drag-region` container and
 * isn't itself an interactive descendant (or one Tauri's own direct-target
 * check would already have excluded).
 */
export function shouldStartDrag(target: ClosestTarget): boolean {
  return Boolean(target.closest("[data-tauri-drag-region]")) && !target.closest(NO_DRAG_SELECTOR);
}

/**
 * Tauri only checks the direct event target. Handle nested title/header content
 * on every desktop platform, while keeping buttons and inputs interactive.
 */
export function useWindowDrag(): { onMouseDown?: (event: MouseEvent<HTMLElement>) => void } {
  const { isDesktop } = useDesktopChrome();

  const onMouseDown = useCallback((event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if (!shouldStartDrag(event.target as HTMLElement)) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.detail === 2) {
      void toggleMaximizeWindow();
    } else {
      void startDraggingWindow();
    }
  }, []);

  return isDesktop ? { onMouseDown } : {};
}
