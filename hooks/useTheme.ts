"use client";

import { useCallback, useSyncExternalStore } from "react";
import { isDarkTheme, isThemePreference, type ThemePreference, type ResolvedTheme } from "@/lib/theme";
import { APP_PREF_KEYS, getPref, setPref } from "@/lib/app-prefs";
import { isTauriDesktop } from "@/lib/desktop-updater";

export type { ThemePreference, ResolvedTheme } from "@/lib/theme";

type ThemeState = {
  preference: ThemePreference;
  theme: ResolvedTheme;
};

type ToggleOrigin = { x: number; y: number };

const SERVER_SNAPSHOT: ThemeState = { preference: "auto", theme: "light" };

const listeners = new Set<() => void>();
let state: ThemeState | null = null;
let systemListening = false;

function emit(): void {
  listeners.forEach((cb) => cb());
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStoredPreference(): ThemePreference {
  try {
    const value = getPref(APP_PREF_KEYS.theme);
    if (isThemePreference(value)) return value;
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
  return "auto";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "auto" ? getSystemTheme() : preference;
}

function applyDomTheme(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", isDarkTheme(theme));
}

function ensureState(): ThemeState {
  if (typeof window === "undefined") return SERVER_SNAPSHOT;
  if (state) return state;

  const preference = readStoredPreference();
  const theme = resolveTheme(preference);
  applyDomTheme(theme);
  state = { preference, theme };
  return state;
}

// The desktop shell mirrors the resolved theme into its config via the
// `set_ui_theme` command: the packaged server's port (and therefore the
// WebView origin, and therefore localStorage) can change between cold starts.
async function persistNativeTheme(theme: ResolvedTheme): Promise<void> {
  if (!isTauriDesktop()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_ui_theme", { theme });
  } catch {
    // Tauri IPC may not be ready on the very first tick; next toggle retries.
  }
}

function setThemeState(preference: ThemePreference, theme: ResolvedTheme, persist: boolean): void {
  applyDomTheme(theme);
  if (persist) {
    void persistNativeTheme(theme);
    try {
      setPref(APP_PREF_KEYS.theme, preference);
    } catch {
      // ignore storage errors (private mode, quota, etc.)
    }
  }
  state = { preference, theme };
  emit();
}

function syncAutoThemeFromSystem(): void {
  const current = ensureState();
  if (current.preference !== "auto") return;
  const theme = getSystemTheme();
  if (theme === current.theme) return;
  setThemeState("auto", theme, false);
}

function ensureSystemListener(): void {
  if (systemListening || typeof window === "undefined" || !window.matchMedia) return;

  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  mql.addEventListener("change", syncAutoThemeFromSystem);
  // Some browsers delay or miss scheme events while backgrounded.
  window.addEventListener("focus", syncAutoThemeFromSystem);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncAutoThemeFromSystem();
  });
  systemListening = true;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  ensureState();
  ensureSystemListener();
  syncAutoThemeFromSystem();
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): ThemeState {
  return ensureState();
}

function getServerSnapshot(): ThemeState {
  return SERVER_SNAPSHOT;
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setThemePreference = useCallback((nextPreference: ThemePreference, origin?: ToggleOrigin) => {
    const current = ensureState();
    if (current.preference === nextPreference) return;
    const nextTheme = resolveTheme(nextPreference);

    const apply = () => {
      setThemeState(nextPreference, nextTheme, true);
    };

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // WebKitGTK crashes its UI process when startViewTransition is called, so
    // the desktop shell keeps the existing instant-switch fallback.
    const supportsVT = !isTauriDesktop() && typeof document.startViewTransition === "function";

    if (!supportsVT || reduceMotion) {
      apply();
      return;
    }

    const x = origin?.x ?? window.innerWidth / 2;
    const y = origin?.y ?? window.innerHeight / 2;
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );

    const transition = document.startViewTransition(apply);
    transition.ready
      .then(() => {
        document.documentElement.animate(
          nextTheme === "mist" || nextTheme === "pine"
            ? { opacity: [0, 1] }
            : { clipPath: [
                `circle(0px at ${x}px ${y}px)`,
                `circle(${endRadius}px at ${x}px ${y}px)`,
              ] },
          {
            duration: nextTheme === "mist" ? 500 : nextTheme === "pine" ? 220 : 450,
            easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => {
        // transition cancelled — ignore
      });
  }, []);

  const toggleTheme = useCallback((origin?: ToggleOrigin) => {
    const current = ensureState();
    const order: ThemePreference[] = ["light", "dark", "auto"];
    const index = order.indexOf(current.preference);
    setThemePreference(order[(index + 1) % order.length], origin);
  }, [setThemePreference]);

  return {
    theme: snapshot.theme,
    preference: snapshot.preference,
    setThemePreference,
    toggleTheme,
    isDark: isDarkTheme(snapshot.theme),
  };
}
