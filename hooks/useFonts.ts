"use client";

import { useSyncExternalStore } from "react";
import { APP_PREF_KEYS, getPrefJson, setPrefJson } from "@/lib/app-prefs";
import { applyFontPreferences, DEFAULT_FONTS, FONT_CHANGE_EVENT, isFontPreferences, type FontPreferences } from "@/lib/font-preferences";

type State = { fonts: FontPreferences; saving: boolean; error: "load" | "save" | null };
const SERVER_STATE: State = { fonts: DEFAULT_FONTS, saving: false, error: null };
let state: State | null = null;
let loadingStarted = false;
let revision = 0;
let writeQueue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function publish(next: State) {
  state = next;
  applyFontPreferences(next.fonts);
  setPrefJson(APP_PREF_KEYS.fonts, next.fonts);
  window.dispatchEvent(new Event(FONT_CHANGE_EVENT));
  listeners.forEach((listener) => listener());
}

function snapshot(): State {
  if (typeof window === "undefined") return SERVER_STATE;
  if (!state) {
    const saved = getPrefJson<unknown>(APP_PREF_KEYS.fonts);
    state = { ...SERVER_STATE, fonts: isFontPreferences(saved) ? saved : DEFAULT_FONTS };
    applyFontPreferences(state.fonts);
  }
  return state;
}

function restore() {
  if (loadingStarted) return;
  loadingStarted = true;
  const startedAt = revision;
  void fetch("/api/appearance/fonts", { cache: "no-store", signal: AbortSignal.timeout(10_000) })
    .then(async (response) => {
      if (!response.ok) throw new Error("Could not read fonts");
      return response.json() as Promise<{ fonts?: unknown }>;
    })
    .then(({ fonts }) => {
      if (startedAt !== revision) return;
      publish({ fonts: isFontPreferences(fonts) ? fonts : snapshot().fonts, saving: false, error: null });
    })
    .catch(() => { if (startedAt === revision) publish({ ...snapshot(), error: "load" }); });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  snapshot();
  restore();
  return () => { listeners.delete(listener); };
}

function setFonts(fonts: FontPreferences) {
  if (!isFontPreferences(fonts)) return;
  const selectedAt = ++revision;
  publish({ fonts, saving: true, error: null });
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    try {
      const response = await fetch("/api/appearance/fonts", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fonts }), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Could not save fonts");
      if (selectedAt === revision) publish({ fonts, saving: false, error: null });
    } catch {
      if (selectedAt === revision) publish({ fonts, saving: false, error: "save" });
    }
  });
}

function retry() {
  if (snapshot().error === "load") { loadingStarted = false; restore(); }
  else setFonts(snapshot().fonts);
}

export function useFonts() {
  return { ...useSyncExternalStore(subscribe, snapshot, () => SERVER_STATE), setFonts, retry };
}
