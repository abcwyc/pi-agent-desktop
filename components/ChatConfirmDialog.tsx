"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { openStackedDialog } from "@/lib/stacked-dialog";

/**
 * Shared confirmation for conversation deletion and access to the computer.
 * Escape closes only this dialog; submitting keeps its progress and errors visible.
 */
export function ChatConfirmDialog({
  title,
  subject,
  body,
  children,
  initialFocusRef,
  checkboxLabel,
  checkboxDefault = false,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}: {
  title: string;
  /** Full conversation name, separate from the action and its consequences. */
  subject?: string;
  body: string;
  children?: ReactNode;
  initialFocusRef?: RefObject<HTMLInputElement | null>;
  /** An optional switch under the text; its value is handed to `onConfirm`. */
  checkboxLabel?: string;
  checkboxDefault?: boolean;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (checked: boolean) => void;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [checked, setChecked] = useState(checkboxDefault);
  const busyRef = useRef(busy);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    busyRef.current = busy;
    onCancelRef.current = onCancel;
  }, [busy, onCancel]);
  useEffect(() => {
    const close = openStackedDialog(document, dialogRef.current, () => {
      if (!busyRef.current) onCancelRef.current();
    });
    initialFocusRef?.current?.focus();
    initialFocusRef?.current?.select();
    return close;
  }, [initialFocusRef]);
  useEffect(() => {
    // Disabling the focused submit button can otherwise drop focus behind the modal.
    if (busy) dialogRef.current?.focus({ preventScroll: true });
  }, [busy]);

  return (
    <div
      role="presentation"
      className="project-trust-backdrop"
      onClick={(event) => {
        event.stopPropagation();
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${subject ? `${id}-subject ` : ""}${id}-body`}
        tabIndex={-1}
        className="project-trust-dialog chat-confirm-dialog"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
          const first = controls[0];
          const last = controls.at(-1);
          if (!first) { event.preventDefault(); event.currentTarget.focus(); }
          else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
            event.preventDefault(); last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault(); first.focus();
          }
        }}
      >
        <div className="project-trust-body">
          <div className="project-trust-content">
            <div id={`${id}-title`} className="project-trust-title">{title}</div>
            {subject && <div id={`${id}-subject`} className="chat-confirm-subject">{subject}</div>}
            <div id={`${id}-body`} className="project-trust-text">{body}</div>
            {children}
            {checkboxLabel && (
              <label className="chat-confirm-check">
                <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} disabled={busy} />
                <span>{checkboxLabel}</span>
              </label>
            )}
          </div>
        </div>
        {error && <div role="alert" className="project-trust-error">{error}</div>}
        <div className="project-trust-footer">
          <button type="button" className="project-trust-button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`project-trust-button is-primary${danger ? " is-danger" : ""}`}
            onClick={() => onConfirm(checked)}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
