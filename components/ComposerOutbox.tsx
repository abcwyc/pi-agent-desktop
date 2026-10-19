"use client";

import { useRef, useState } from "react";
import type { PendingComposerMessage } from "@/lib/composer-queue-types";
import { useI18n } from "@/hooks/useI18n";

export type ComposerQueueAction = "send" | "edit" | "delete";

export function ComposerOutbox({ items, onAction }: {
  items: PendingComposerMessage[];
  onAction?: (id: string, action: ComposerQueueAction) => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const actionPending = useRef(false);
  const act = async (id: string, action: ComposerQueueAction) => {
    if (actionPending.current || !onAction) return;
    actionPending.current = true;
    setBusy(id);
    try { await onAction(id, action); } finally { actionPending.current = false; setBusy(null); }
  };
  if (!items.length) return null;
  return (
    <div className="composer-outbox" role="list" aria-label={t("chat.pendingMessages")}>
      {items.map(item => (
        <div className="composer-outbox-row" role="listitem" key={item.id} aria-busy={busy === item.id}>
          <svg className="composer-outbox-mark" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 4v10a3 3 0 0 0 3 3h11M15 13l4 4-4 4M9 5h8M9 9h5" />
          </svg>
          <button className="composer-outbox-preview" type="button" title={item.message || t("chat.queuedImages", { count: item.images?.length ?? 0 })}
            aria-label={t("chat.editQueuedMessage") + ": " + (item.message || t("chat.queuedImages", { count: item.images?.length ?? 0 }))}
            disabled={Boolean(busy) || !onAction} onClick={() => void act(item.id, "edit")}>
            {item.message || t("chat.queuedImages", { count: item.images?.length ?? 0 })}
            {item.message && Boolean(item.images?.length) && <span className="composer-outbox-image-count"> · {t("chat.queuedImages", { count: item.images!.length })}</span>}
          </button>
          <div className="composer-outbox-actions">
            <button className="composer-outbox-send" type="button" title={t("chat.sendQueuedNowTitle")} aria-label={t("chat.sendQueuedNow")} disabled={Boolean(busy) || !onAction} onClick={() => void act(item.id, "send")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5v7a3 3 0 0 0 3 3h12M14 10l5 5-5 5" /></svg>
              <span className="composer-outbox-send-label">{t("chat.sendQueuedNow")}</span>
            </button>
            <button type="button" title={t("chat.editQueuedMessage")} aria-label={t("chat.editQueuedMessage")} disabled={Boolean(busy) || !onAction} onClick={() => void act(item.id, "edit")}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15z" /></svg>
            </button>
            <button type="button" title={t("chat.deleteQueuedMessage")} aria-label={t("chat.deleteQueuedMessage")} disabled={Boolean(busy) || !onAction} onClick={() => void act(item.id, "delete")}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
