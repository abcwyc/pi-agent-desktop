/** Pure description of a native menu and how it is built through Tauri's menu API (no Tauri imports, so it is unit-testable in Node). */

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
 * What `createNativeMenuItems` needs from Tauri's menu API. Every `item`,
 * `submenu`, ... call must return a *standalone* resource (`MenuItem.new`, not a
 * nested options object): tauri 2.12 drops an item's JS channel as soon as the
 * Rust wrapper built from nested `Menu.new({ items })` options goes out of
 * scope, so an `action` given that way never fires. Standalone resources stay
 * in the resource table until closed, which keeps the channel alive.
 */
export interface NativeMenuFactory<T> {
  separator(): Promise<T>;
  predefined(item: "Copy" | "Cut" | "Paste" | "SelectAll" | "Undo" | "Redo", text?: string): Promise<T>;
  item(options: { text: string; enabled: boolean; action: () => void; checked?: boolean }): Promise<T>;
  submenu(options: { text: string; enabled: boolean; items: T[] }): Promise<T>;
}

/** Builds every entry (submenus depth-first) through `factory`, in order. */
export async function createNativeMenuItems<T>(
  entries: NativeMenuEntry[],
  factory: NativeMenuFactory<T>,
): Promise<T[]> {
  const out: T[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "separator":
        out.push(await factory.separator());
        break;
      case "predefined":
        out.push(await factory.predefined(entry.item, entry.label));
        break;
      case "submenu":
        out.push(await factory.submenu({
          text: entry.label,
          enabled: !entry.disabled,
          items: await createNativeMenuItems(entry.items, factory),
        }));
        break;
      default: {
        const options: Parameters<NativeMenuFactory<T>["item"]>[0] = {
          text: entry.label,
          enabled: !entry.disabled,
          action: () => entry.onSelect?.(),
        };
        if (entry.checked !== undefined) options.checked = entry.checked;
        out.push(await factory.item(options));
      }
    }
  }
  return out;
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
