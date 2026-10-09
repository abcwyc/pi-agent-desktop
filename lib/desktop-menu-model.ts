/** Pure description of a native menu and its mapping to Tauri's `Menu.new` options (no Tauri imports, so it is unit-testable in Node). */

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

type TauriMenuItemOptions = Record<string, unknown>;

/** Maps entries to the plain option objects `Menu.new({ items })` accepts. */
export function toTauriMenuItems(entries: NativeMenuEntry[]): TauriMenuItemOptions[] {
  return entries.map((entry): TauriMenuItemOptions => {
    switch (entry.kind) {
      case "separator":
        return { item: "Separator" };
      case "predefined":
        return entry.label ? { item: entry.item, text: entry.label } : { item: entry.item };
      case "submenu":
        return {
          text: entry.label,
          enabled: !entry.disabled,
          items: toTauriMenuItems(entry.items),
        };
      default: {
        const options: TauriMenuItemOptions = {
          text: entry.label,
          enabled: !entry.disabled,
          action: () => entry.onSelect?.(),
        };
        if (entry.checked !== undefined) options.checked = entry.checked;
        return options;
      }
    }
  });
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
