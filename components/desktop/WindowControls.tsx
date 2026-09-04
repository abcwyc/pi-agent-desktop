"use client";

import { useCallback, useEffect, useState } from "react";

import { isTauriDesktop } from "@/lib/desktop-updater";
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  toggleMaximizeWindow,
} from "@/lib/desktop-window";

import { useDesktopChrome } from "./useDesktopChrome";
import { useI18n } from "@/hooks/useI18n";

/**
 * Minimize / maximize / close buttons for a frameless desktop window.
 *
 * Renders nothing in the browser, and nothing on macOS either — there the
 * native traffic lights stay visible and the top bar just insets around them.
 * Self-contained on purpose: the host only has to mount it, so upstream layout
 * files carry a single line instead of the state, effects and icons.
 */
export function WindowControls() {
  const { isDesktop, isMacOS } = useDesktopChrome();
  const { t } = useI18n();
  const [maximized, setMaximized] = useState(false);
  const drawsOwnControls = isDesktop && !isMacOS;

  useEffect(() => {
    if (!isTauriDesktop() || !drawsOwnControls) return;

    const refresh = () => { void isWindowMaximized().then(setMaximized); };
    refresh();
    window.addEventListener("resize", refresh);
    return () => window.removeEventListener("resize", refresh);
  }, [drawsOwnControls]);

  const handleToggleMaximize = useCallback(async () => {
    await toggleMaximizeWindow();
    setMaximized(await isWindowMaximized());
  }, []);

  if (!drawsOwnControls) return null;

  return (
    <div className="window-controls">
      <button
        type="button"
        className="window-control-btn"
        aria-label={t("windowControls.minimize")}
        onClick={() => { void minimizeWindow(); }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
          <line x1="0" y1="5" x2="10" y2="5" />
        </svg>
      </button>
      <button
        type="button"
        className="window-control-btn"
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => { void handleToggleMaximize(); }}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="2" y="0.5" width="7.5" height="7.5" />
            <path d="M0.5 2.5 V9.5 H7.5" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="window-control-btn window-control-btn--close"
        aria-label={t("windowControls.close")}
        onClick={() => { void closeWindow(); }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
          <line x1="0" y1="0" x2="10" y2="10" /><line x1="10" y1="0" x2="0" y2="10" />
        </svg>
      </button>
    </div>
  );
}
