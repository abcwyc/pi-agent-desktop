"use client";

import { useEffect, useState } from "react";
import type { AppUpdateInfo, AppUpdatesResponse } from "@/lib/app-update-types";
import { PRODUCT_NAME } from "@/lib/branding";
import { APP_PREF_KEYS, getPrefJson, setPrefJson } from "@/lib/app-prefs";
import { handleExternalLinkClick } from "@/lib/desktop-native";
import { useI18n } from "@/hooks/useI18n";

const RETRY_AFTER_ERROR_MS = 6 * 60 * 60 * 1000;
const MAX_TIMER_MS = 2_147_000_000;
const SNOOZE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

interface SnoozeRecord {
  until: number;
  /** Which exact update set was dismissed — a newer release reappears immediately. */
  signature: string;
}

function updatesSignature(updates: AppUpdateInfo[]): string {
  return updates
    .map((update) => `${update.project}@${update.latestVersion}`)
    .sort()
    .join(",");
}

function loadSnooze(): SnoozeRecord | null {
  if (typeof window === "undefined") return null;
  const parsed = getPrefJson<Partial<SnoozeRecord>>(APP_PREF_KEYS.updateSnooze);
  if (!parsed || typeof parsed.until !== "number" || typeof parsed.signature !== "string") return null;
  return { until: parsed.until, signature: parsed.signature };
}

function saveSnooze(record: SnoozeRecord): void {
  setPrefJson(APP_PREF_KEYS.updateSnooze, record);
}

function isSnoozed(updates: AppUpdateInfo[]): boolean {
  const snooze = loadSnooze();
  if (!snooze) return false;
  if (Date.now() >= snooze.until) return false;
  return snooze.signature === updatesSignature(updates);
}

export function UpdateReminder({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  const [updates, setUpdates] = useState<AppUpdateInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const schedule = (delay: number) => {
      if (cancelled) return;
      timer = setTimeout(runCheck, Math.min(MAX_TIMER_MS, Math.max(60_000, delay)));
    };

    const runCheck = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch("/api/updates", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as AppUpdatesResponse;
        if (cancelled) return;
        if (Array.isArray(data.updates) && data.updates.length > 0 && !isSnoozed(data.updates)) {
          setUpdates(data.updates);
        }
        const nextCheckAt = Date.parse(data.nextCheckAt);
        schedule(Number.isFinite(nextCheckAt) ? nextCheckAt - Date.now() : RETRY_AFTER_ERROR_MS);
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        schedule(RETRY_AFTER_ERROR_MS);
      }
    };

    void runCheck();
    return () => {
      cancelled = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (updates.length === 0) return null;

  const handleOpenSettings = () => {
    setUpdates([]);
    onOpenSettings();
  };

  const handleSnooze = () => {
    saveSnooze({ until: Date.now() + SNOOZE_DURATION_MS, signature: updatesSignature(updates) });
    setUpdates([]);
  };

  return (
    <aside
      className="native-update-reminder"
      aria-label={t("updates.available")}
      aria-live="polite"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 1200,
        width: "min(380px, calc(100vw - 32px))",
        border: "var(--hairline) solid var(--border)",
        borderRadius: 10,
        background: "var(--bg-panel)",
        boxShadow: "0 14px 40px rgba(0, 0, 0, 0.24)",
        color: "var(--text)",
        overflow: "hidden",
      }}
    >
      <div className="native-update-reminder-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px 10px" }}>
        <div className="native-update-reminder-title" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700 }}>
          <span className="native-update-reminder-icon" aria-hidden="true" style={{ color: "var(--accent)", fontSize: 16 }}>↑</span>
          {t("updates.available")}
        </div>
        <button
          className="native-modal-close"
          type="button"
          aria-label={t("updates.dismiss")}
          title={t("updates.remindNextWeek")}
          onClick={handleSnooze}
          style={{
            padding: "1px 5px",
            border: 0,
            background: "transparent",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 19,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
      <div className="native-update-reminder-body" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 14px 12px" }}>
        {updates.map((update) => (
          <div
            className="native-update-reminder-row"
            key={update.project}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "9px 10px",
              border: "var(--hairline) solid var(--border)",
              borderRadius: 7,
              background: "var(--bg)",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 650 }}>{update.name}</div>
              <div style={{ marginTop: 3, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
                {update.currentVersion} → {update.latestVersion}
              </div>
            </div>
            <a
              className="native-update-reminder-link"
              href={update.releaseUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => handleExternalLinkClick(event, update.releaseUrl)}
              style={{
                flexShrink: 0,
                color: "var(--accent)",
                fontSize: 11,
                fontWeight: 650,
                textDecoration: "none",
              }}
            >
              {t("updates.viewRelease")}
            </a>
          </div>
        ))}
        <div className="native-update-reminder-caption" style={{ color: "var(--text-dim)", fontSize: 10, lineHeight: 1.45 }}>
          {t("updates.caption", { product: PRODUCT_NAME })}
        </div>
        <button
          className="native-button native-button-primary"
          type="button"
          onClick={handleOpenSettings}
          style={{ alignSelf: "flex-end" }}
        >
          {t("updates.openSettings")}
        </button>
      </div>
    </aside>
  );
}
