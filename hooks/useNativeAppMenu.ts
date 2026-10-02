"use client";

import { useEffect } from "react";

import { isTauriDesktop } from "@/lib/desktop-updater";

/**
 * Connect Tauri's native macOS menu events to the web app state. The hook is
 * isolated so browser-only tests and SSR never touch Tauri's event plugin.
 */
export function useNativeAppMenu(onAction: (action: string) => void): void {
  useEffect(() => {
    if (!isTauriDesktop()) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;

    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<string>("pi-agent-menu-action", ({ payload }) => {
        onAction(payload);
      }))
      .then((unlisten) => {
        if (cancelled) unlisten();
        else dispose = unlisten;
      })
      .catch((error) => {
        console.error("Failed to connect the native app menu:", error);
      });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [onAction]);
}
