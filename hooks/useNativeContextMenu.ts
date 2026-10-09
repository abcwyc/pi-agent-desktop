import { useEffect } from "react";
import { showNativeMenu, type NativeMenuEntry } from "@/lib/desktop-menu";
import { isTauriDesktop } from "@/lib/desktop-updater";

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled;
  if (target instanceof HTMLInputElement) {
    return !target.readOnly && !target.disabled
      && ["text", "search", "url", "email", "tel", "password", "number", ""].includes(target.type);
  }
  return false;
}

function hasSelection(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return (target.selectionStart ?? 0) !== (target.selectionEnd ?? 0);
  }
  return (window.getSelection()?.toString() ?? "") !== "";
}

/**
 * Desktop shell fallback for right-clicks nothing else claimed: a native
 * Cut / Copy / Paste menu on text fields, Copy / Select All on selected text,
 * and no webview menu (Reload / Inspect Element) anywhere else. Components with
 * their own native menu call `preventDefault()` first, which this respects.
 * The webview's own menu stays in `next dev`, where Inspect Element is wanted.
 */
export function useNativeContextMenu(): void {
  useEffect(() => {
    if (!isTauriDesktop()) return;
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const at = { x: event.clientX, y: event.clientY };
      let entries: NativeMenuEntry[] | null = null;
      if (isEditable(event.target)) {
        entries = [
          { kind: "predefined", item: "Cut" },
          { kind: "predefined", item: "Copy" },
          { kind: "predefined", item: "Paste" },
          { kind: "separator" },
          { kind: "predefined", item: "SelectAll" },
        ];
      } else if (hasSelection(event.target)) {
        entries = [
          { kind: "predefined", item: "Copy" },
          { kind: "separator" },
          { kind: "predefined", item: "SelectAll" },
        ];
      }
      if (!entries && process.env.NODE_ENV !== "production") return;
      event.preventDefault();
      if (entries) void showNativeMenu(entries, at);
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);
}
