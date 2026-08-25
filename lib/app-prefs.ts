/**
 * Unified app preference storage. Backed by localStorage in both the web UI
 * and the Tauri WebView so prefs survive reloads. Theme is additionally mirrored
 * into the desktop app config dir (see `set_ui_theme`) so cold starts keep the
 * choice even if the local server port / origin changes.
 */

export const APP_PREF_KEYS = {
  theme: "pi-theme",
  locale: "pi-locale",
  soundEnabled: "pi-sound-enabled",
  sidebarWidth: "pi-sidebar-width",
  rightPanelWidth: "pi-right-panel-width",
  unreadSessionIds: "pi-web:unread-session-ids",
  archivedProjects: "pi-web:archived-projects",
  updateSnooze: "pi-web:update-snooze",
  closeQuits: "pi-desktop-close-quits",
  notifyOnComplete: "pi-desktop-notify-on-complete",
  chatDrafts: "pi-chat-drafts-v1",
  /** Last open session / cwd / file tabs for desktop cold-start restore. */
  workspace: "pi-workspace-v1",
} as const;

export type AppPrefKey = (typeof APP_PREF_KEYS)[keyof typeof APP_PREF_KEYS];

export function getPref(key: AppPrefKey): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setPref(key: AppPrefKey, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // private mode / quota
  }
}

export function removePref(key: AppPrefKey): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function getPrefBool(key: AppPrefKey, fallback: boolean): boolean {
  const raw = getPref(key);
  if (raw === null) return fallback;
  return raw === "true";
}

export function setPrefBool(key: AppPrefKey, value: boolean): void {
  setPref(key, String(value));
}

export function getPrefJson<T>(key: AppPrefKey): T | null {
  const raw = getPref(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function setPrefJson(key: AppPrefKey, value: unknown): void {
  try {
    setPref(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}
