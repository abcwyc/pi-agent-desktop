/**
 * Types for the desktop update check.
 *
 * Kept out of lib/api-types.ts, which agegr/pi-web owns and extends on its own
 * schedule. Appending fork types there made every upstream edit to that file
 * land on a fork-modified file for no benefit — nothing outside the desktop
 * update flow consumes these. See docs/ownership-boundaries.md.
 */

export type AppUpdateProjectId = "pi-agent-desktop";

export type AppReleaseStatus = "available" | "unpublished" | "unknown";

export interface AppComponentReleaseInfo {
  project: AppUpdateProjectId;
  name: string;
  repository: string;
  repositoryUrl: string;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  updateAvailable: boolean;
  releaseStatus: AppReleaseStatus;
  /**
   * Titles of the latest release's headline items (the bold lead-ins under
   * "New", else "Improved"), per notes language. Absent for older caches.
   */
  highlights?: AppReleaseHighlights;
}

export interface AppReleaseHighlights {
  en: string[];
  zh: string[];
}

export interface AppUpdateInfo {
  project: AppUpdateProjectId;
  name: string;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
}

export interface AppUpdatesResponse {
  checkedAt: string;
  nextCheckAt: string;
  components: AppComponentReleaseInfo[];
  updates: AppUpdateInfo[];
  errors?: Array<{
    project: AppUpdateProjectId;
    message: string;
  }>;
}
