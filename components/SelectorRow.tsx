"use client";

import type { ReactNode } from "react";

function StarIcon({ filled, size }: { filled: boolean; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <polygon points="12 2.5 14.9 8.6 21.5 9.4 16.6 13.9 17.9 20.5 12 17.2 6.1 20.5 7.4 13.9 2.5 9.4 9.1 8.6" />
    </svg>
  );
}

export interface SelectorRowStar {
  /** This row is the default new sessions start with. */
  isDefault: boolean;
  /** Title and accessible name of the save button on the other rows. */
  saveLabel: string;
  /** Title and accessible name of the default row's marker. */
  defaultLabel: string;
  onSave: () => void;
}

/**
 * A selector menu row styled like a session-list row: the whole row selects
 * and highlights on hover. With `star`, the right gutter holds the default
 * marker: a filled star on the default row, and a plain outline star on
 * every other row that saves it as the default through its own action.
 */
export function SelectorRow({
  active,
  onSelect,
  star,
  gutter = Boolean(star),
  children,
}: {
  active: boolean;
  onSelect: () => void;
  star?: SelectorRowStar;
  /** Keep room for the star so it never covers the row's text; pass it to every row of a menu that has stars so they line up. */
  gutter?: boolean;
  children: ReactNode;
}) {
  const canSave = Boolean(star && !star.isDefault);

  return (
    <div
      className="app-option-row"
      data-selected={active || undefined}
      style={{
        position: "relative",
        background: active ? "var(--bg-selected)" : "transparent",
        transition: "background 0.1s",
      }}
    >
      <button
        type="button"
        role="option"
        aria-selected={active}
        onClick={onSelect}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          width: "100%", minWidth: 0, padding: gutter ? "7px 36px 7px 12px" : "7px 12px",
          border: "none", background: "none",
          color: active ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer", fontSize: 12, fontWeight: active ? 600 : 400,
          textAlign: "left", whiteSpace: "nowrap",
        }}
      >
        {children}
      </button>
      {star?.isDefault && (
        <span
          className="app-default-star is-default"
          role="img"
          aria-label={star.defaultLabel}
          title={star.defaultLabel}
          style={{
            position: "absolute", top: "50%", right: 6, transform: "translateY(-50%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 24, height: 24,
          }}
        >
          <StarIcon filled size={14} />
        </span>
      )}
      {star && canSave && (
        <button
          className="app-default-star"
          type="button"
          title={star.saveLabel}
          aria-label={star.saveLabel}
          onClick={(event) => {
            event.stopPropagation();
            // Saving replaces this button with a filled marker; keep focus
            // inside the menu so Escape and arrow navigation still work.
            event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('[role="option"]')?.focus({ preventScroll: true });
            star.onSave();
          }}
          style={{
            position: "absolute", top: "50%", right: 6, transform: "translateY(-50%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 24, height: 24, padding: 0,
            background: "transparent", border: 0,
            cursor: "pointer",
          }}
        >
          <StarIcon filled={false} size={14} />
        </button>
      )}
    </div>
  );
}
