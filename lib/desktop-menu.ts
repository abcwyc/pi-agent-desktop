import { isTauriDesktop } from "@/lib/desktop-updater";
import {
  createNativeMenuItems,
  tidyMenuEntries,
  type NativeMenuEntry,
  type NativeMenuFactory,
} from "./desktop-menu-model";

export type { NativeMenuEntry } from "./desktop-menu-model";

/**
 * Native (NSMenu / Win32 / GTK) context menus for the Tauri shell.
 *
 * Every caller keeps its DOM menu for the browser build: `showNativeMenu`
 * resolves `false` when it cannot show one (not the desktop shell, or the IPC
 * failed), and the caller then opens the DOM menu as before.
 */

// A menu and its items live in the Rust resource table until closed. Item
// actions arrive over IPC after the popup returns, so a menu is closed when the
// *next* one opens, never right after its own popup.
interface MenuResource {
  close: () => Promise<void>;
}
let lastMenu: MenuResource[] = [];

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
  const tidy = tidyMenuEntries(entries);
  if (tidy.length === 0) return true;
  try {
    const [{ Menu, MenuItem, CheckMenuItem, Submenu, PredefinedMenuItem }, { LogicalPosition }] = await Promise.all([
      import("@tauri-apps/api/menu"),
      import("@tauri-apps/api/dpi"),
    ]);
    const previous = lastMenu;
    lastMenu = [];
    for (const resource of previous) void resource.close().catch(() => {});

    const created: MenuResource[] = [];
    lastMenu = created;
    const track = <T extends MenuResource>(resource: T): T => {
      created.push(resource);
      return resource;
    };
    // Items are created as standalone resources and handed to the menu by
    // reference: see NativeMenuFactory for why nested options lose `action`.
    const factory: NativeMenuFactory<MenuResource> = {
      separator: async () => track(await PredefinedMenuItem.new({ item: "Separator" })),
      predefined: async (item, text) =>
        track(await PredefinedMenuItem.new(text ? { item, text } : { item })),
      item: async ({ checked, ...options }) =>
        track(checked === undefined
          ? await MenuItem.new(options)
          : await CheckMenuItem.new({ ...options, checked })),
      submenu: async (options) =>
        track(await Submenu.new({ ...options, items: options.items as never })),
    };
    const items = await createNativeMenuItems(tidy, factory);
    const menu = track(await Menu.new({ items: items as never }));
    await menu.popup(at ? new LogicalPosition(at.x, at.y) : undefined);
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
