"use client";

import { FormEvent, useCallback, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { openExternal } from "@/lib/desktop-native";

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function BrowserIcon({ type }: { type: "back" | "forward" | "reload" | "external" }) {
  if (type === "reload") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 11a8 8 0 1 0 2 5.3" />
        <path d="M20 4v7h-7" />
      </svg>
    );
  }
  if (type === "external") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 3h7v7" />
        <path d="M10 14 21 3" />
        <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={type === "back" ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
    </svg>
  );
}

export function BrowserPanel() {
  const { t } = useI18n();
  const [address, setAddress] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [reloadKey, setReloadKey] = useState(0);

  const navigate = useCallback((nextValue: string, addToHistory = true) => {
    const nextUrl = normalizeUrl(nextValue);
    if (!nextUrl) return;
    setAddress(nextUrl);
    setCurrentUrl(nextUrl);
    setReloadKey(0);
    if (addToHistory) {
      setHistory((previous) => [...previous.slice(0, historyIndex + 1), nextUrl]);
      setHistoryIndex((previous) => previous + 1);
    }
  }, [historyIndex]);

  const submit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigate(address);
  }, [address, navigate]);

  const goHistory = useCallback((offset: number) => {
    const nextIndex = historyIndex + offset;
    const nextUrl = history[nextIndex];
    if (!nextUrl) return;
    setHistoryIndex(nextIndex);
    setAddress(nextUrl);
    setCurrentUrl(nextUrl);
    setReloadKey(0);
  }, [history, historyIndex]);

  return (
    <div className="context-browser-panel">
      <form className="context-browser-toolbar" onSubmit={submit}>
        <button type="button" className="context-browser-icon-button" onClick={() => goHistory(-1)} disabled={historyIndex <= 0} title={t("contextPanel.browserBack")} aria-label={t("contextPanel.browserBack")}>
          <BrowserIcon type="back" />
        </button>
        <button type="button" className="context-browser-icon-button" onClick={() => goHistory(1)} disabled={historyIndex < 0 || historyIndex >= history.length - 1} title={t("contextPanel.browserForward")} aria-label={t("contextPanel.browserForward")}>
          <BrowserIcon type="forward" />
        </button>
        <button type="button" className="context-browser-icon-button" onClick={() => setReloadKey((key) => key + 1)} disabled={!currentUrl} title={t("contextPanel.browserReload")} aria-label={t("contextPanel.browserReload")}>
          <BrowserIcon type="reload" />
        </button>
        <input
          className="context-browser-address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder={t("contextPanel.browserPlaceholder")}
          aria-label={t("contextPanel.browserAddress")}
          spellCheck={false}
          inputMode="url"
        />
        <button type="submit" className="context-browser-go-button">{t("contextPanel.browserGo")}</button>
        <button type="button" className="context-browser-icon-button" onClick={() => { if (currentUrl) void openExternal(currentUrl); }} disabled={!currentUrl} title={t("contextPanel.browserOpenExternal")} aria-label={t("contextPanel.browserOpenExternal")}>
          <BrowserIcon type="external" />
        </button>
      </form>
      {currentUrl ? (
        <iframe
          key={`${currentUrl}:${reloadKey}`}
          className="context-browser-frame"
          src={currentUrl}
          title={t("contextPanel.browser")}
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="context-browser-empty" role="status">
          <span className="context-browser-empty-icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3c2.2 2.4 3.3 5.4 3.3 9s-1.1 6.6-3.3 9c-2.2-2.4-3.3-5.4-3.3-9S9.8 5.4 12 3Z" />
            </svg>
          </span>
          <strong>{t("contextPanel.browserEmpty")}</strong>
          <span>{t("contextPanel.browserHint")}</span>
        </div>
      )}
    </div>
  );
}
