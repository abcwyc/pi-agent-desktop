"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { NativeMenuEntry } from "@/lib/desktop-menu-model";
import { closeDomMenu, getDomMenu, subscribeDomMenu, type DomMenuState } from "@/lib/dom-menu-store";
import { isImeComposing } from "@/lib/ime";

/**
 * The in-app context menu: the DOM counterpart of `showNativeMenu`, drawn from
 * the same entries (`openDomMenu` in lib/dom-menu-store.ts). Mount once. It
 * stands in for the native popup while those are switched off
 * (`NATIVE_POPUP_MENUS_ENABLED`), so it needs no IPC and holds no lock.
 *
 * One submenu level is supported (the file menu's "Open With"); a submenu
 * nested inside a submenu is not rendered.
 */

const VIEWPORT_MARGIN = 8;
/** Submenus overlap their parent a little so the pointer can cross the seam. */
const SUBMENU_OVERLAP = 4;

type Item = Extract<NativeMenuEntry, { kind?: "item" }>;
type Submenu = Extract<NativeMenuEntry, { kind: "submenu" }>;

interface OpenSubmenu {
  index: number;
  rect: DOMRect;
  /** Opened from the keyboard: its items take focus. */
  focus: boolean;
}

type Place = (size: { width: number; height: number }) => { left: number; top: number };

function clamp(value: number, max: number): number {
  return Math.max(VIEWPORT_MARGIN, Math.min(value, max));
}

function MenuPanel({
  entries,
  place,
  panelRef,
  label,
  onItem,
  onSubmenu,
  openIndex,
  autoFocus,
  onKeyboardClose,
}: {
  entries: NativeMenuEntry[];
  place: Place;
  panelRef: React.RefObject<HTMLDivElement | null>;
  label?: string;
  onItem: (item: Item) => void;
  onSubmenu?: (index: number, rect: DOMRect | null, byKeyboard?: boolean) => void;
  openIndex?: number | null;
  /** Take focus once the panel is placed and visible (focus on a hidden element is ignored). */
  autoFocus?: boolean;
  /** Called for ArrowLeft in a submenu. */
  onKeyboardClose?: () => void;
}) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  // Measured before paint so the menu never flashes at an unclamped spot.
  useLayoutEffect(() => {
    const node = panelRef.current;
    if (!node) return;
    setPosition(place({ width: node.offsetWidth, height: node.offsetHeight }));
  }, [panelRef, place, entries]);

  useEffect(() => {
    if (position && autoFocus) panelRef.current?.focus({ preventScroll: true });
  }, [position, autoFocus, panelRef]);

  const hasChecks = entries.some((entry) => entry.kind !== "separator" && entry.kind !== "submenu" && entry.kind !== "predefined" && entry.checked !== undefined);

  const focusable = (): HTMLButtonElement[] =>
    Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)") ?? []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event)) return;
    const buttons = focusable();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (buttons.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      // Nothing focused yet: ArrowDown starts at the first item, ArrowUp at the last.
      const next = at < 0 ? (step > 0 ? 0 : buttons.length - 1) : (at + step + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === "ArrowRight" && onSubmenu && at >= 0) {
      const button = buttons[at];
      if (button?.getAttribute("aria-haspopup") === "menu") {
        event.preventDefault();
        button.click();
      }
    } else if (event.key === "ArrowLeft" && onKeyboardClose) {
      event.preventDefault();
      onKeyboardClose();
    }
  };

  return (
    <div
      ref={panelRef}
      className="dom-context-menu native-popover"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      style={position
        ? { left: position.left, top: position.top, maxHeight: `calc(100vh - ${VIEWPORT_MARGIN * 2}px)` }
        : { left: -9999, top: -9999, visibility: "hidden" }}
    >
      {entries.map((entry, index) => {
        if (entry.kind === "separator") {
          return <div key={index} className="dom-context-menu-separator" role="separator" />;
        }
        if (entry.kind === "predefined") return null;
        if (entry.kind === "submenu") {
          // Only the root panel opens submenus.
          if (!onSubmenu) return null;
          return (
            <button
              key={index}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={openIndex === index}
              disabled={entry.disabled}
              onMouseEnter={(event) => onSubmenu(index, event.currentTarget.getBoundingClientRect())}
              // A click with no pointer (Enter, ArrowRight) has `detail === 0`.
              onClick={(event) => onSubmenu(index, event.currentTarget.getBoundingClientRect(), event.detail === 0)}
            >
              {hasChecks && <span className="dom-context-menu-check" />}
              <span className="dom-context-menu-label">{entry.label}</span>
              <span className="dom-context-menu-chevron" aria-hidden="true">›</span>
            </button>
          );
        }
        return (
          <button
            key={index}
            type="button"
            role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={entry.checked}
            disabled={entry.disabled}
            // Moving onto a plain item closes an open submenu, as native menus do.
            onMouseEnter={onSubmenu ? () => onSubmenu(-1, null) : undefined}
            onClick={() => onItem(entry)}
          >
            {hasChecks && <span className="dom-context-menu-check" aria-hidden="true">{entry.checked ? "✓" : ""}</span>}
            <span className="dom-context-menu-label">{entry.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function MenuView({ menu }: { menu: DomMenuState }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<OpenSubmenu | null>(null);

  const placeRoot = useCallback<Place>(({ width, height }) => ({
    left: clamp(menu.at.x, window.innerWidth - width - VIEWPORT_MARGIN),
    top: clamp(menu.at.y, window.innerHeight - height - VIEWPORT_MARGIN),
  }), [menu.at.x, menu.at.y]);

  const subRect = sub?.rect;
  const placeSub = useCallback<Place>(({ width, height }) => {
    if (!subRect) return { left: 0, top: 0 };
    const right = subRect.right - SUBMENU_OVERLAP;
    const flip = right + width > window.innerWidth - VIEWPORT_MARGIN;
    return {
      left: clamp(flip ? subRect.left - width + SUBMENU_OVERLAP : right, window.innerWidth - width - VIEWPORT_MARGIN),
      top: clamp(subRect.top - 4, window.innerHeight - height - VIEWPORT_MARGIN),
    };
  }, [subRect]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || subRef.current?.contains(target)) return;
      closeDomMenu();
    };
    const onScroll = (event: Event) => {
      const target = event.target as Node;
      // A long submenu scrolls itself; the page behind it moving is what closes the menu.
      if (rootRef.current?.contains(target) || subRef.current?.contains(target)) return;
      closeDomMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isImeComposing(event)) return;
      event.preventDefault();
      closeDomMenu();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", closeDomMenu);
    window.addEventListener("resize", closeDomMenu);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", closeDomMenu);
      window.removeEventListener("resize", closeDomMenu);
    };
  }, []);

  const onItem = useCallback((item: Item) => {
    closeDomMenu();
    item.onSelect?.();
  }, []);

  const onSubmenu = useCallback((index: number, rect: DOMRect | null, byKeyboard = false) => {
    setSub((current) => {
      if (index < 0 || !rect) return null;
      // Re-entering the open row keeps the submenu where it is.
      if (current?.index === index) return byKeyboard && !current.focus ? { ...current, focus: true } : current;
      return { index, rect, focus: byKeyboard };
    });
  }, []);

  const openEntry = sub ? (menu.entries[sub.index] as Submenu | undefined) : undefined;
  const openSubmenu = openEntry?.kind === "submenu" ? openEntry : undefined;

  return (
    <>
      <MenuPanel
        entries={menu.entries}
        place={placeRoot}
        panelRef={rootRef}
        onItem={onItem}
        onSubmenu={onSubmenu}
        openIndex={sub?.index ?? null}
        autoFocus={!sub?.focus}
      />
      {openSubmenu && (
        <MenuPanel
          key={sub?.index}
          entries={openSubmenu.items}
          place={placeSub}
          panelRef={subRef}
          label={openSubmenu.label}
          onItem={onItem}
          autoFocus={sub?.focus}
          onKeyboardClose={() => {
            setSub(null);
            rootRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

export function DomContextMenuHost() {
  const menu = useSyncExternalStore(subscribeDomMenu, getDomMenu, () => null);
  if (!menu) return null;
  return createPortal(<MenuView key={menu.id} menu={menu} />, document.body);
}
