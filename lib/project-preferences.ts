import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getPiWebSettingsPath, readStored } from "./artifact-settings";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { parseProjectNames, projectNameKey, type ProjectNames } from "./project-display";

export interface ProjectPreferences { initialized: boolean; names: ProjectNames; archived: string[] }
export type ProjectPreferenceChange =
  | { action: "rename"; path: string; name: string }
  | { action: "archive" | "restore"; path: string }
  | { action: "migrate"; names: ProjectNames; archived: string[] };

export function projectPreferencesPath() {
  return join(dirname(getPiWebSettingsPath()), "projects.json");
}
export function readProjectPreferences(path = projectPreferencesPath()): ProjectPreferences {
  const data = readStored(path);
  return { initialized: data.version === 1, names: parseProjectNames(JSON.stringify(data.names ?? {})),
    archived: Array.isArray(data.archived) ? data.archived.filter((p): p is string => typeof p === "string") : [] };
}

/** Synchronous read/modify/atomic replace: no await between reading and writing. */
export function changeProjectPreferences(change: ProjectPreferenceChange, path = projectPreferencesPath()): ProjectPreferences {
  const previous = readProjectPreferences(path);
  if (change.action === "migrate" && previous.initialized) return previous;
  const names = { ...(change.action === "migrate" ? parseProjectNames(JSON.stringify(change.names)) : previous.names) };
  let archived = previous.archived;
  if (change.action === "migrate") {
    archived = [...new Set(change.archived)];
  } else if (change.action === "rename") {
    const key = projectNameKey(change.path), name = change.name.trim().slice(0, 100);
    if (name) Object.defineProperty(names, key, { value: name, enumerable: true, configurable: true });
    else delete names[key];
  } else {
    archived = archived.filter(root => projectNameKey(root) !== projectNameKey(change.path));
    if (change.action === "archive") archived.push(change.path);
  }
  const result = { initialized: true, names, archived };
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify({ version: 1, names, archived }, null, 2));
  return result;
}
