/** Pure description of a native menu and how it is handed to the desktop shell (no Tauri imports, so it is unit-testable in Node). */

export type NativeMenuEntry =
  | {
      kind?: "item";
      label: string;
      onSelect?: () => void;
      disabled?: boolean;
      /** Renders a check mark; `true`/`false` both make it a check item. */
      checked?: boolean;
    }
  | { kind: "separator" }
  | { kind: "submenu"; label: string; items: NativeMenuEntry[]; disabled?: boolean }
  | {
      kind: "predefined";
      item: "Copy" | "Cut" | "Paste" | "SelectAll" | "Undo" | "Redo";
      /** Overrides the OS-localised label. */
      label?: string;
    };

/**
 * What the Rust `show_popup_menu` command takes (`PopupMenuEntry` in
 * src-tauri/src/lib.rs; the shapes are pinned on both sides). Plain data only:
 * the menu is built and shown in Rust and the page learns which item was
 * picked from the command's result, so there are no menu resources or click
 * channels on the JS side.
 */
export type PopupMenuSpec =
  | { kind: "item"; id: string; text: string; enabled: boolean; checked?: boolean }
  | { kind: "separator" }
  | { kind: "submenu"; text: string; enabled: boolean; items: PopupMenuSpec[] }
  | { kind: "predefined"; item: "Copy" | "Cut" | "Paste" | "SelectAll" | "Undo" | "Redo"; text?: string };

/**
 * Turns entries into the spec plus the handlers to run for each item id. Ids
 * are sequential strings, unique across submenus.
 */
export function toPopupSpec(entries: NativeMenuEntry[]): {
  items: PopupMenuSpec[];
  actions: Map<string, () => void>;
} {
  const actions = new Map<string, () => void>();
  let next = 0;
  const convert = (list: NativeMenuEntry[]): PopupMenuSpec[] => {
    const out: PopupMenuSpec[] = [];
    for (const entry of list) {
      switch (entry.kind) {
        case "separator":
          out.push({ kind: "separator" });
          break;
        case "predefined":
          out.push({ kind: "predefined", item: entry.item, ...(entry.label ? { text: entry.label } : {}) });
          break;
        case "submenu":
          out.push({ kind: "submenu", text: entry.label, enabled: !entry.disabled, items: convert(entry.items) });
          break;
        default: {
          const id = String(next++);
          if (entry.onSelect) actions.set(id, entry.onSelect);
          out.push({
            kind: "item",
            id,
            text: entry.label,
            enabled: !entry.disabled,
            ...(entry.checked !== undefined ? { checked: entry.checked } : {}),
          });
        }
      }
    }
    return out;
  };
  return { items: convert(entries), actions };
}

/** Drops separators that lead, trail or repeat, so callers can build lists with conditional groups. */
export function tidyMenuEntries(entries: NativeMenuEntry[]): NativeMenuEntry[] {
  const out: NativeMenuEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "separator" && (out.length === 0 || out[out.length - 1].kind === "separator")) continue;
    out.push(entry);
  }
  while (out.length > 0 && out[out.length - 1].kind === "separator") out.pop();
  return out;
}
