import type { NativeMenuEntry } from "./desktop-menu-model";

/**
 * State of the one in-app context menu (see components/DomContextMenuHost.tsx).
 *
 * Callers that run outside the React tree — the file right-click hook is
 * invoked from a `contextmenu` handler and awaits an app lookup first — open
 * it through `openDomMenu` with the same entries the native popup takes, so a
 * menu is described once whichever way it is shown.
 */

export interface DomMenuState {
  /** Changes on every open, so a menu opened over another one remounts. */
  id: number;
  /** Entries to show; `predefined` items have no DOM equivalent and are dropped. */
  entries: NativeMenuEntry[];
  /** Viewport coordinates (the right-click position). */
  at: { x: number; y: number };
}

type Listener = () => void;

let current: DomMenuState | null = null;
let sequence = 0;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Entries the DOM menu can render, with the separators tidied around what was dropped. */
export function domMenuEntries(entries: NativeMenuEntry[]): NativeMenuEntry[] {
  const out: NativeMenuEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "predefined") continue;
    if (entry.kind === "separator" && (out.length === 0 || out[out.length - 1].kind === "separator")) continue;
    out.push(entry);
  }
  while (out.length > 0 && out[out.length - 1].kind === "separator") out.pop();
  return out;
}

export function openDomMenu(entries: NativeMenuEntry[], at: { x: number; y: number }): void {
  const tidy = domMenuEntries(entries);
  current = tidy.length > 0 ? { id: ++sequence, entries: tidy, at } : null;
  emit();
}

export function closeDomMenu(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function getDomMenu(): DomMenuState | null {
  return current;
}

export function subscribeDomMenu(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
