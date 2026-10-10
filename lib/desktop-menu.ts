import { isTauriDesktop } from "@/lib/desktop-updater";
import {
  tidyMenuEntries,
  toPopupSpec,
  type NativeMenuEntry,
} from "./desktop-menu-model";

export type { NativeMenuEntry } from "./desktop-menu-model";

/**
 * Native (NSMenu / Win32 / GTK) context menus for the Tauri shell.
 *
 * Every caller keeps its DOM menu for the browser build: `showNativeMenu`
 * resolves `false` when it cannot show one (not the desktop shell, or the IPC
 * failed), and the caller then opens the DOM menu as before.
 */

/**
 * Native popups are on in the desktop shell; `NEXT_PUBLIC_NATIVE_POPUP_MENUS=0`
 * at build time switches them off, and every caller then uses its DOM menu.
 * Opening Settings froze the app for a user in 0.6.x, and the suspect was the
 * way menus used to be driven from JS: tauri's `menu.popup` command holds the
 * webview's resource-table lock while the main thread runs the menu. Menus now
 * go through `show_popup_menu`, which builds and shows them in Rust and hands
 * the picked id back as the command's result; a test build with this on was
 * checked by the user who reported the freeze.
 */
export const NATIVE_POPUP_MENUS_ENABLED = process.env.NEXT_PUBLIC_NATIVE_POPUP_MENUS !== "0";

/** Whether a caller should try a native popup at all (desktop shell and not switched off). */
export function canUseNativeMenu(): boolean {
  return NATIVE_POPUP_MENUS_ENABLED && isTauriDesktop();
}

export interface NativeMenuPoint {
  x: number;
  y: number;
}

/**
 * Shows `entries` as a native popup menu at `at` (window client coordinates;
 * the cursor when omitted). Resolves `true` once the menu was shown and
 * dismissed, `false` when the caller should fall back to its DOM menu.
 *
 * The picked item's `onSelect` runs after the menu has closed, from the
 * command's result, never while the menu is open.
 */
export async function showNativeMenu(
  entries: NativeMenuEntry[],
  at?: NativeMenuPoint,
): Promise<boolean> {
  if (!canUseNativeMenu()) return false;
  const tidy = tidyMenuEntries(entries);
  if (tidy.length === 0) return true;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const { items, actions } = toPopupSpec(tidy);
    const chosen = await invoke<string | null>("show_popup_menu", { items, at: at ?? null });
    if (chosen) actions.get(chosen)?.();
    return true;
  } catch (error) {
    // A silent `false` once hid a menu that popped up but could not act; leave a trace.
    console.warn("[desktop-menu] native menu failed, falling back to the DOM menu", error);
    return false;
  }
}

/** Anchor for a menu that drops down from `element`'s bottom-left corner. */
export function menuPointBelow(element: Element, align: "left" | "right" = "left"): NativeMenuPoint {
  const rect = element.getBoundingClientRect();
  return { x: align === "right" ? rect.right : rect.left, y: rect.bottom + 2 };
}
