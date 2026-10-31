"use client";

import { APP_PREF_KEYS, getPref, getPrefJson, setPrefJson } from "./app-prefs";
import { parseProjectNames, projectNameKey } from "./project-display";
import { appNotify } from "./notification-store";
import type { ProjectPreferenceChange, ProjectPreferences } from "./project-preferences";

const empty: ProjectPreferences = { initialized: false, names: {}, archived: [] };
let base = empty, snapshot = empty;
let loading: Promise<void> | null = null;
let queue = Promise.resolve();
const pending: ProjectPreferenceChange[] = [];
const listeners = new Set<() => void>();

async function request(change?: ProjectPreferenceChange): Promise<ProjectPreferences> {
  const response = await fetch("/api/project-preferences", change ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change), keepalive: true,
  } : { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to save or load project preferences. Please retry.");
  return response.json();
}
function publish() {
  const names = { ...base.names };
  let archived = [...base.archived];
  for (const change of pending) {
    if (change.action === "rename") {
      const key = projectNameKey(change.path), name = change.name.trim().slice(0, 100);
      if (name) Object.defineProperty(names, key, { value: name, enumerable: true, configurable: true });
      else delete names[key];
    } else if (change.action !== "migrate") {
      archived = archived.filter(root => projectNameKey(root) !== projectNameKey(change.path));
      if (change.action === "archive") archived.push(change.path);
    }
  }
  snapshot = { ...base, names, archived };
  if (base.initialized) {
    // A cache only. Never write this back over an initialized server file.
    setPrefJson(APP_PREF_KEYS.projectNames, names);
    setPrefJson(APP_PREF_KEYS.archivedProjects, archived);
  }
  listeners.forEach(listener => listener());
}
async function initialize() {
  if (!loading) loading = (async () => {
    base = await request();
    if (!base.initialized) {
      const archived = getPrefJson<unknown>(APP_PREF_KEYS.archivedProjects);
      base = await request({ action: "migrate", names: parseProjectNames(getPref(APP_PREF_KEYS.projectNames)),
        archived: Array.isArray(archived) ? archived.filter((p): p is string => typeof p === "string") : [] });
    }
    publish();
  })().catch(error => { loading = null; throw error; });
  return loading;
}
function report(error: unknown) { appNotify.error({ message: error instanceof Error ? error.message : String(error) }); }
function refresh() {
  queue = queue.then(async () => { await initialize(); base = await request(); publish(); }).catch(report);
}
export function subscribeProjectPreferences(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) { window.addEventListener("focus", refresh); refresh(); }
  return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener("focus", refresh); };
}
export const projectPreferencesSnapshot = () => snapshot;
export const serverProjectPreferencesSnapshot = () => empty;
export function updateProjectPreferences(change: ProjectPreferenceChange) {
  pending.push(change); publish();
  queue = queue.then(async () => {
    try { await initialize(); base = await request(change); }
    catch (error) { report(error); }
    finally { pending.splice(pending.indexOf(change), 1); publish(); }
  });
}
