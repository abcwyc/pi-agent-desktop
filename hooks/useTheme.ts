"use client";

import { useCallback, useSyncExternalStore } from "react";
import { APP_PREF_KEYS, getPref, setPref } from "@/lib/app-prefs";
import { isTauriDesktop } from "@/lib/desktop-updater";

type Theme = "light" | "dark";

const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function getServerSnapshot(): Theme {
  return "light";
}

function storedTheme(): Theme | null {
  const t = getPref(APP_PREF_KEYS.theme);
  return t === "dark" || t === "light" ? t : null;
}

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function paintThemeClass(next: Theme) {
  document.documentElement.classList.toggle("dark", next === "dark");
  document.documentElement.style.colorScheme = next;
}

async function persistNativeTheme(theme: Theme): Promise<void> {
  if (!isTauriDesktop()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_ui_theme", { theme });
  } catch {
    // Tauri IPC may not be ready on the very first tick; next toggle retries.
  }
}

function notify() {
  listeners.forEach((cb) => cb());
}

function applyTheme(next: Theme, animate: boolean) {
  const apply = () => {
    paintThemeClass(next);
    setPref(APP_PREF_KEYS.theme, next);
    void persistNativeTheme(next);
    notify();
  };

  if (!animate) {
    apply();
    return;
  }

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // WebKitGTK crashes its UI process when startViewTransition is called, so the
  // desktop shell keeps the existing instant-switch fallback.
  const supportsVT =
    !isTauriDesktop() && typeof document.startViewTransition === "function";

  if (!supportsVT || reduceMotion) {
    apply();
    return;
  }

  try {
    const transition = document.startViewTransition(apply);
    // A navigation or rapid second toggle can legitimately abort a transition.
    // Consume those promise rejections so they do not surface as app errors.
    void transition.ready.catch(() => {});
    void transition.updateCallbackDone.catch(() => {});
    void transition.finished.catch(() => {});
  } catch {
    apply();
  }
}

// Apply the resolved theme synchronously on first client import so React
// hydration never briefly inherits the OS appearance after the blocking
// layout script. Also mirror an explicit choice into the desktop store.
if (typeof window !== "undefined") {
  const stored = storedTheme();
  paintThemeClass(stored ?? systemTheme());
  if (stored) {
    // Defer IPC until after the current turn so __TAURI_INTERNALS__ is ready.
    queueMicrotask(() => {
      void persistNativeTheme(stored);
    });
  }

  // Follow the OS appearance until the user picks a theme explicitly
  // (toggleTheme / setTheme persists the choice, which stops the auto-follow).
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  media?.addEventListener?.("change", (event) => {
    if (storedTheme() !== null) return;
    paintThemeClass(event.matches ? "dark" : "light");
    notify();
  });
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggleTheme = useCallback(() => {
    applyTheme(getSnapshot() === "dark" ? "light" : "dark", true);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    // Always persist — clicking the already-active choice should still pin the
    // preference so a later OS dark-mode change cannot steal it back.
    if (getSnapshot() === next) {
      setPref(APP_PREF_KEYS.theme, next);
      void persistNativeTheme(next);
      return;
    }
    applyTheme(next, true);
  }, []);

  return { theme, toggleTheme, setTheme, isDark: theme === "dark" };
}
