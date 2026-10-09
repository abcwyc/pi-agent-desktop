import { isTauriDesktop } from "@/lib/desktop-updater";
import { tidyMenuEntries, toTauriMenuItems, type NativeMenuEntry } from "./desktop-menu-model";

export type { NativeMenuEntry } from "./desktop-menu-model";

/**
 * Native (NSMenu / Win32 / GTK) context menus for the Tauri shell.
 *
 * Every caller keeps its DOM menu for the browser build: `showNativeMenu`
 * resolves `false` when it cannot show one (not the desktop shell, or the IPC
 * failed), and the caller then opens the DOM menu as before.
 */

// The menu resource lives in the Rust side until closed. Item actions arrive
// over IPC after the popup returns, so a menu is closed when the *next* one
// opens, never right after its own popup.
let lastMenu: { close: () => Promise<void> } | null = null;

export interface NativeMenuPoint {
  x: number;
  y: number;
}

/**
 * Shows `entries` as a native popup menu at `at` (window client coordinates;
 * the cursor when omitted). Resolves `true` once the menu was shown and
 * dismissed, `false` when the caller should fall back to its DOM menu.
 */
export async function showNativeMenu(
  entries: NativeMenuEntry[],
  at?: NativeMenuPoint,
): Promise<boolean> {
  if (!isTauriDesktop()) return false;
  const items = toTauriMenuItems(tidyMenuEntries(entries));
  if (items.length === 0) return true;
  try {
    const [{ Menu }, { LogicalPosition }] = await Promise.all([
      import("@tauri-apps/api/menu"),
      import("@tauri-apps/api/dpi"),
    ]);
    const previous = lastMenu;
    lastMenu = null;
    void previous?.close().catch(() => {});
    const menu = await Menu.new({ items: items as never });
    lastMenu = menu;
    await menu.popup(at ? new LogicalPosition(at.x, at.y) : undefined);
    return true;
  } catch {
    return false;
  }
}

/** Anchor for a menu that drops down from `element`'s bottom-left corner. */
export function menuPointBelow(element: Element, align: "left" | "right" = "left"): NativeMenuPoint {
  const rect = element.getBoundingClientRect();
  return { x: align === "right" ? rect.right : rect.left, y: rect.bottom + 2 };
}
