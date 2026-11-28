"use client";

import { useSyncExternalStore } from "react";

export type AppNoticeType = "info" | "success" | "warning" | "error";

export interface AppNoticeInput {
  id?: string;
  message: string;
  type?: AppNoticeType;
  /** Keep an in-progress operation or an actionable error visible until updated/dismissed. */
  persistent?: boolean;
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
// Entering or updating another notice can reschedule expiry, but must not
// cancel the removal of a row that already started its exit animation.
const exitTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  const exitTimer = exitTimers.get(id);
  if (exitTimer !== undefined) clearTimeout(exitTimer);
  exitTimers.delete(id);
  if (!notices.some((notice) => notice.id === id)) return;
  notices = notices.filter((notice) => notice.id !== id);
  emit();
  scheduleExpiry();
}

function startNoticeExit(ids: readonly string[]): void {
  const exitingIds = new Set(ids);
  notices = notices.map((notice) => {
    if (notice.exiting || !exitingIds.has(notice.id)) return notice;
    if (!exitTimers.has(notice.id)) {
      exitTimers.set(notice.id, setTimeout(() => removeNotice(notice.id), NOTICE_EXIT_ANIMATION_MS));
    }
    return { ...notice, exiting: true };
  });
}

function autoExpires(notice: AppNotice): boolean {
  return !notice.exiting && !notice.action && !notice.persistent;
}

function scheduleExpiry(): void {
  clearExpiryTimer();
  const now = Date.now();
  const deadlines = notices
    .filter(autoExpires)
    .map((notice) => notice.createdAt + NOTICE_VISIBLE_MS)
    .filter((deadline) => deadline > now);
  if (deadlines.length === 0) return;
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    const current = Date.now();
    const expiredIds = notices
      .filter((notice) => autoExpires(notice) && notice.createdAt + NOTICE_VISIBLE_MS <= current)
      .map((notice) => notice.id);
    if (expiredIds.length > 0) {
      startNoticeExit(expiredIds);
      emit();
    }
    scheduleExpiry();
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
  notices = [...notices, notice];
  if (notices.length > MAX_NOTICES) {
    const oldest = notices.find((item) => !item.exiting);
    if (oldest) startNoticeExit([oldest.id]);
  }
  emit();
  scheduleExpiry();
  return notice.id;
}

export function dismissAppNotice(id: string): void {
  const notice = notices.find((item) => item.id === id);
  if (!notice) return;
  if (notice.exiting) {
    removeNotice(id);
    return;
  }
  startNoticeExit([id]);
  emit();
  scheduleExpiry();
}

/** Replace progress with its result in place. Never resurrect a dismissed notice. */
export function updateAppNotice(id: string, input: Omit<AppNoticeInput, "id">): boolean {
  const message = input.message.trim();
  if (!message || !notices.some((notice) => notice.id === id && !notice.exiting)) return false;
  notices = notices.map((notice) => notice.id === id
    ? { ...notice, ...input, message, type: input.type ?? notice.type, createdAt: Date.now() }
    : notice);
  emit();
  scheduleExpiry();
  return true;
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
  for (const timer of exitTimers.values()) clearTimeout(timer);
  exitTimers.clear();
  notices = [];
  emit();
}
