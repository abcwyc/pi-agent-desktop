"use client";

import { useSyncExternalStore } from "react";

export type AppNoticeType = "info" | "success" | "warning" | "error";

export interface AppNoticeInput {
  id?: string;
  message: string;
  type?: AppNoticeType;
  /**
   * Notices with an action do not auto-expire. The caller owns the translated
   * label and keeps the handler current; the store only owns presentation.
   */
  action?: {
    label: string;
    run: () => void | Promise<void>;
  };
}

export interface AppNotice extends AppNoticeInput {
  id: string;
  message: string;
  type: AppNoticeType;
  createdAt: number;
  exiting?: boolean;
}

const MAX_NOTICES = 4;
const NOTICE_VISIBLE_MS = 7000;
const NOTICE_EXIT_ANIMATION_MS = 180;
const EMPTY_SERVER_NOTICES: readonly AppNotice[] = [];
const listeners = new Set<() => void>();
let notices: readonly AppNotice[] = [];
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): readonly AppNotice[] {
  return notices;
}

function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clearExpiryTimer(): void {
  if (expiryTimer === null) return;
  clearTimeout(expiryTimer);
  expiryTimer = null;
}

function removeNotice(id: string): void {
  if (!notices.some((notice) => notice.id === id)) return;
  notices = notices.filter((notice) => notice.id !== id);
  emit();
  scheduleExpiry();
}

function scheduleExpiry(): void {
  clearExpiryTimer();
  const now = Date.now();
  const deadlines = notices
    .filter((notice) => !notice.exiting && !notice.action)
    .map((notice) => notice.createdAt + NOTICE_VISIBLE_MS)
    .filter((deadline) => deadline > now);
  if (deadlines.length === 0) return;
  expiryTimer = setTimeout(() => {
    const current = Date.now();
    const expiredIds = notices
      .filter((notice) => !notice.exiting && !notice.action && notice.createdAt + NOTICE_VISIBLE_MS <= current)
      .map((notice) => notice.id);
    if (expiredIds.length === 0) {
      scheduleExpiry();
      return;
    }
    notices = notices.map((notice) => expiredIds.includes(notice.id) ? { ...notice, exiting: true } : notice);
    emit();
    expiryTimer = setTimeout(() => {
      notices = notices.filter((notice) => !expiredIds.includes(notice.id));
      emit();
      scheduleExpiry();
    }, NOTICE_EXIT_ANIMATION_MS);
  }, Math.min(...deadlines) - now);
}

function addNotice(input: AppNoticeInput): string {
  const message = input.message.trim();
  if (!message) return "";
  const notice: AppNotice = {
    ...input,
    id: input.id ?? createNoticeId(),
    message,
    type: input.type ?? "info",
    createdAt: Date.now(),
  };
  let next = [...notices, notice];
  if (next.length > MAX_NOTICES) {
    const oldest = next.find((item) => !item.exiting);
    next = oldest
      ? next.map((item) => item.id === oldest.id ? { ...item, exiting: true } : item)
      : next.slice(next.length - MAX_NOTICES);
  }
  const exitingIds = next.filter((item) => item.exiting).map((item) => item.id);
  const overflowing = next.length > MAX_NOTICES;
  notices = next;
  emit();
  if (overflowing && exitingIds.length > 0) {
    expiryTimer = setTimeout(() => {
      notices = notices.filter((item) => !exitingIds.includes(item.id));
      emit();
      scheduleExpiry();
    }, NOTICE_EXIT_ANIMATION_MS);
  } else {
    scheduleExpiry();
  }
  return notice.id;
}

export function dismissAppNotice(id: string): void {
  const notice = notices.find((item) => item.id === id);
  if (!notice) return;
  if (notice.exiting) {
    removeNotice(id);
    return;
  }
  clearExpiryTimer();
  notices = notices.map((item) => item.id === id ? { ...item, exiting: true } : item);
  emit();
  expiryTimer = setTimeout(() => removeNotice(id), NOTICE_EXIT_ANIMATION_MS);
}

export async function runAppNoticeAction(id: string): Promise<void> {
  const notice = notices.find((item) => item.id === id);
  if (!notice?.action) return;
  const action = notice.action;
  dismissAppNotice(id);
  await action.run();
}

export const appNotify = {
  info: (input: Omit<AppNoticeInput, "type">): string => addNotice({ ...input, type: "info" }),
  success: (input: Omit<AppNoticeInput, "type">): string => addNotice({ ...input, type: "success" }),
  warning: (input: Omit<AppNoticeInput, "type">): string => addNotice({ ...input, type: "warning" }),
  error: (input: Omit<AppNoticeInput, "type">): string => addNotice({ ...input, type: "error" }),
};

export function useAppNotices(): readonly AppNotice[] {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SERVER_NOTICES);
}

/** Test hook; also useful if a future route needs to clear transient toasts. */
export function resetAppNoticeStore(): void {
  clearExpiryTimer();
  notices = [];
  emit();
}
