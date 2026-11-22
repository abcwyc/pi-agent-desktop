"use client";

import { useCallback, useSyncExternalStore } from "react";
import { APP_PREF_KEYS, getPref, setPref } from "@/lib/app-prefs";

/**
 * Whether a turn's working steps show their thinking rows. Hidden by default:
 * on a real 47-step turn nearly every step opened with a one-line thinking
 * summary, the largest repeated element after the tool cards. Answers, the
 * streaming reply and a search hit inside a thinking block always show it.
 * One switch for the app, kept in localStorage like the diff view mode; the
 * Process details header and Settings › General › Chat both flip it.
 */
const listeners = new Set<() => void>();

function readStored(): boolean {
  return getPref(APP_PREF_KEYS.processThinking) === "show";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useProcessThinking(): { show: boolean; setShow: (next: boolean) => void } {
  const show = useSyncExternalStore(subscribe, readStored, () => false);
  const setShow = useCallback((next: boolean) => {
    setPref(APP_PREF_KEYS.processThinking, next ? "show" : "hide");
    listeners.forEach((listener) => listener());
  }, []);
  return { show, setShow };
}
