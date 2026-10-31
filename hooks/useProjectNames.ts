"use client";

import { useMemo, useSyncExternalStore } from "react";
import { projectNameKey } from "@/lib/project-display";
import { subscribeProjectPreferences, projectPreferencesSnapshot, serverProjectPreferencesSnapshot, updateProjectPreferences } from "@/lib/project-preferences-client";

const renameProject = (path: string, name: string) => updateProjectPreferences({ action: "rename", path, name });
const archiveProject = (path: string) => updateProjectPreferences({ action: "archive", path });
const restoreProject = (path: string) => updateProjectPreferences({ action: "restore", path });

export function useProjectNames() {
  const prefs = useSyncExternalStore(subscribeProjectPreferences, projectPreferencesSnapshot, serverProjectPreferencesSnapshot);
  return { names: prefs.names, renameProject };
}

export function useArchivedProjects() {
  const prefs = useSyncExternalStore(subscribeProjectPreferences, projectPreferencesSnapshot, serverProjectPreferencesSnapshot);
  const archived = useMemo(() => new Set(prefs.archived.map(projectNameKey)), [prefs.archived]);
  // Normalize lookup only; real project/session paths are unchanged.
  return { isArchived: (path: string) => archived.has(projectNameKey(path)), archiveProject, restoreProject };
}
