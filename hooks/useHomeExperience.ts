"use client";
import { useSyncExternalStore } from "react";
import { APP_PREF_KEYS, getPref, setPref } from "@/lib/app-prefs";

const eventName = "pi-home-experience-changed";
function subscribe(callback: () => void) {
  window.addEventListener(eventName, callback);
  window.addEventListener("storage", callback);
  return () => { window.removeEventListener(eventName, callback); window.removeEventListener("storage", callback); };
}

export function useHomeExperience() {
  const mascot = useSyncExternalStore(subscribe, () => getPref(APP_PREF_KEYS.homeMascot) !== "false", () => true);
  const dashboard = useSyncExternalStore(subscribe, () => getPref(APP_PREF_KEYS.homeDashboard) !== "false", () => true);
  const setOption = (key: "homeMascot" | "homeDashboard", value: boolean) => {
    setPref(APP_PREF_KEYS[key], String(value));
    window.dispatchEvent(new Event(eventName));
  };
  return { mascot, dashboard, setOption };
}
