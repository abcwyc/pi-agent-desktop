"use client";

import { useSyncExternalStore } from "react";
import { APP_PREF_KEYS, getPref, setPref } from "@/lib/app-prefs";
import { DEFAULT_BACKGROUND, isBackgroundPreference, type BackgroundPreference } from "@/lib/backgrounds";

type BackgroundState = { background: BackgroundPreference; error: boolean; saving: boolean };
const SERVER_STATE: BackgroundState = { background: DEFAULT_BACKGROUND, error: false, saving: false };
let state: BackgroundState | null = null;
let loadingStarted = false;
let revision = 0;
let writeQueue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function publish(next: BackgroundState) {
  state = next;
  document.documentElement.dataset.background = next.background;
  setPref(APP_PREF_KEYS.background, next.background);
  listeners.forEach((listener) => listener());
}

function snapshot(): BackgroundState {
  if (typeof window === "undefined") return SERVER_STATE;
  if (!state) {
    const saved = getPref(APP_PREF_KEYS.background);
    state = { ...SERVER_STATE, background: isBackgroundPreference(saved) ? saved : DEFAULT_BACKGROUND };
    document.documentElement.dataset.background = state.background;
  }
  return state;
}

function restore() {
  if (loadingStarted) return;
  loadingStarted = true;
  const startedAt = revision;
  void fetch("/api/appearance", { cache: "no-store", signal: AbortSignal.timeout(10_000) })
    .then(async (response) => {
      if (!response.ok) throw new Error("Could not read appearance");
      return response.json() as Promise<{ background?: unknown }>;
    })
    .then((saved) => {
      if (startedAt !== revision) return;
      if (isBackgroundPreference(saved.background)) publish({ ...snapshot(), background: saved.background, error: false });
    })
    .catch(() => { if (startedAt === revision) publish({ ...snapshot(), error: true }); });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  snapshot();
  restore();
  return () => { listeners.delete(listener); };
}

function setBackground(background: BackgroundPreference) {
  if (!isBackgroundPreference(background)) return;
  const selectedAt = ++revision;
  publish({ background, error: false, saving: true });
  // Serialize writes: quickly clicking several cards must persist the last one.
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    try {
      const response = await fetch("/api/appearance", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ background }), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Could not save appearance");
      if (selectedAt === revision) publish({ background, saving: false, error: false });
    } catch {
      if (selectedAt === revision) publish({ background, saving: false, error: true });
    }
  });
}

export function useBackground() {
  const value = useSyncExternalStore(subscribe, snapshot, () => SERVER_STATE);
  return { ...value, setBackground };
}
