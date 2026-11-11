import { randomUUID } from "crypto";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  APP_UPDATE_PROJECTS,
  APP_UPDATE_RETRY_INTERVAL_MS,
  compareAppVersions,
  getNextAppUpdateCheckAt,
  getLatestAppRelease,
  getUnknownAppReleaseInfo,
  isAppUpdateDue,
} from "@/lib/app-updates";
import type {
  AppComponentReleaseInfo,
  AppReleaseHighlights,
  AppUpdateInfo,
  AppUpdateProjectId,
  AppUpdatesResponse,
} from "@/lib/app-update-types";

export const dynamic = "force-dynamic";

// Version 3 drops the former pi/pi-web checks and their cached notices.
const STATE_VERSION = 3;
const STATE_FILE = "pi-web-update-check.json";

interface UpdateCheckState {
  version: number;
  lastCheckedAt: Partial<Record<AppUpdateProjectId, number>>;
  releases: Partial<Record<AppUpdateProjectId, AppComponentReleaseInfo>>;
}

type UpdateProject = (typeof APP_UPDATE_PROJECTS)[number];

declare global {
  var __piWebAppUpdateCheck: Promise<AppUpdatesResponse> | undefined;
}

function statePath(): string {
  return join(getAgentDir(), STATE_FILE);
}

function emptyState(): UpdateCheckState {
  return { version: STATE_VERSION, lastCheckedAt: {}, releases: {} };
}

function restoreHighlights(value: unknown): { highlights: AppReleaseHighlights } | null {
  if (!value || typeof value !== "object") return null;
  const { en, zh } = value as Partial<Record<keyof AppReleaseHighlights, unknown>>;
  const strings = (list: unknown): string[] | null => (
    Array.isArray(list) && list.every((item) => typeof item === "string") ? list as string[] : null
  );
  const restoredEn = strings(en);
  const restoredZh = strings(zh);
  if (!restoredEn || !restoredZh) return null;
  return { highlights: { en: restoredEn.slice(0, 8), zh: restoredZh.slice(0, 8) } };
}

function restoreCachedRelease(
  project: UpdateProject,
  value: unknown,
): AppComponentReleaseInfo | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<AppComponentReleaseInfo>;
  const base = getUnknownAppReleaseInfo(project);

  if (raw.project !== project.id) return null;
  if (raw.releaseStatus === "unpublished") {
    return { ...base, releaseStatus: "unpublished" };
  }
  if (
    raw.releaseStatus !== "available"
    || typeof raw.latestVersion !== "string"
    || typeof raw.releaseUrl !== "string"
  ) {
    return null;
  }

  try {
    const releaseUrl = new URL(raw.releaseUrl);
    if (releaseUrl.protocol !== "https:" || releaseUrl.hostname !== "github.com") return null;
    return {
      ...base,
      latestVersion: raw.latestVersion,
      releaseUrl: releaseUrl.toString(),
      updateAvailable: compareAppVersions(raw.latestVersion, base.currentVersion) > 0,
      releaseStatus: "available",
      ...(restoreHighlights(raw.highlights) ?? {}),
    };
  } catch {
    return null;
  }
}

async function readState(): Promise<UpdateCheckState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), "utf8")) as {
      version?: unknown;
      lastCheckedAt?: unknown;
      releases?: unknown;
    };
    if (
      parsed.version !== STATE_VERSION
      || !parsed.lastCheckedAt
      || typeof parsed.lastCheckedAt !== "object"
      || !parsed.releases
      || typeof parsed.releases !== "object"
    ) {
      return emptyState();
    }

    const raw = parsed.lastCheckedAt as Record<string, unknown>;
    const rawReleases = parsed.releases as Record<string, unknown>;
    const lastCheckedAt: UpdateCheckState["lastCheckedAt"] = {};
    const releases: UpdateCheckState["releases"] = {};
    for (const project of APP_UPDATE_PROJECTS) {
      const value = raw[project.id];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        lastCheckedAt[project.id] = value;
      }
      const release = rawReleases[project.id];
      const restored = restoreCachedRelease(project, release);
      if (restored) releases[project.id] = restored;
    }
    return { version: STATE_VERSION, lastCheckedAt, releases };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    return emptyState();
  }
}

async function writeState(state: UpdateCheckState): Promise<void> {
  const file = statePath();
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function performUpdateCheck(forceRefresh = false): Promise<AppUpdatesResponse> {
  const now = Date.now();
  const state = await readState();
  const dueProjects = APP_UPDATE_PROJECTS.filter((project) => (
    forceRefresh || isAppUpdateDue(state.lastCheckedAt[project.id], now)
  ));

  const settled = await Promise.allSettled(dueProjects.map(async (project) => ({
    project,
    release: await getLatestAppRelease(project),
  })));
  const updates: AppUpdateInfo[] = [];
  const errors: NonNullable<AppUpdatesResponse["errors"]> = [];
  let stateChanged = false;

  for (let index = 0; index < settled.length; index++) {
    const result = settled[index];
    const project = dueProjects[index];
    if (result.status === "fulfilled") {
      state.lastCheckedAt[project.id] = now;
      state.releases[project.id] = result.value.release;
      stateChanged = true;
      const release = result.value.release;
      if (release.updateAvailable && release.latestVersion && release.releaseUrl) {
        updates.push({
          project: release.project,
          name: release.name,
          currentVersion: release.currentVersion,
          latestVersion: release.latestVersion,
          releaseUrl: release.releaseUrl,
        });
      }
    } else {
      errors.push({
        project: project.id,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  if (stateChanged) await writeState(state);
  const nextCheck = errors.length > 0
    ? now + APP_UPDATE_RETRY_INTERVAL_MS
    : getNextAppUpdateCheckAt(state.lastCheckedAt, now);

  return {
    checkedAt: new Date(now).toISOString(),
    nextCheckAt: new Date(nextCheck).toISOString(),
    components: APP_UPDATE_PROJECTS.map((project) => (
      state.releases[project.id] ?? getUnknownAppReleaseInfo(project)
    )),
    updates,
    ...(errors.length > 0 && { errors }),
  };
}

export async function GET(request: Request) {
  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (!globalThis.__piWebAppUpdateCheck) {
    globalThis.__piWebAppUpdateCheck = performUpdateCheck(forceRefresh)
      .finally(() => {
        globalThis.__piWebAppUpdateCheck = undefined;
      });
  }

  try {
    return Response.json(await globalThis.__piWebAppUpdateCheck);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
