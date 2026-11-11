import type {
  AppComponentReleaseInfo,
  AppReleaseHighlights,
  AppUpdateInfo,
  AppUpdateProjectId,
} from "@/lib/app-update-types";
import { APP_DISTRIBUTION_NAME, APP_VERSION } from "./branding";

export const APP_UPDATE_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const APP_UPDATE_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface AppUpdateProject {
  id: AppUpdateProjectId;
  name: string;
  repository: `${string}/${string}`;
  currentVersion: string;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  body?: unknown;
}

interface ParsedVersion {
  display: string;
  core: [number, number, number];
  prerelease: string[];
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export const APP_UPDATE_PROJECTS: readonly AppUpdateProject[] = [
  {
    id: "pi-agent-desktop",
    name: APP_DISTRIBUTION_NAME,
    repository: "abcwyc/pi-agent-desktop",
    currentVersion: APP_VERSION,
  },
];

function parseVersion(value: string): ParsedVersion | null {
  const display = value.trim().replace(/^v/i, "");
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(display);
  if (!match) return null;

  return {
    display,
    core: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }

  return 0;
}

export function compareAppVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`Invalid version comparison: ${left} / ${right}`);

  for (let index = 0; index < a.core.length; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function isAppUpdateDue(lastCheckedAt: number | undefined, now: number): boolean {
  return !Number.isFinite(lastCheckedAt)
    || now - (lastCheckedAt as number) >= APP_UPDATE_CHECK_INTERVAL_MS
    || now < (lastCheckedAt as number);
}

export function getNextAppUpdateCheckAt(
  lastCheckedAt: Partial<Record<AppUpdateProjectId, number>>,
  now: number,
): number {
  return Math.min(...APP_UPDATE_PROJECTS.map((project) => {
    const checkedAt = lastCheckedAt[project.id];
    return Number.isFinite(checkedAt)
      ? Math.max(now, (checkedAt as number) + APP_UPDATE_CHECK_INTERVAL_MS)
      : now;
  }));
}

function repositoryUrl(project: AppUpdateProject): string {
  return `https://github.com/${project.repository}`;
}

export function getUnknownAppReleaseInfo(project: AppUpdateProject): AppComponentReleaseInfo {
  return {
    project: project.id,
    name: project.name,
    repository: project.repository,
    repositoryUrl: repositoryUrl(project),
    currentVersion: parseVersion(project.currentVersion)?.display ?? project.currentVersion,
    latestVersion: null,
    releaseUrl: null,
    updateAvailable: false,
    releaseStatus: "unknown",
  };
}

function unpublishedRelease(project: AppUpdateProject): AppComponentReleaseInfo {
  return {
    ...getUnknownAppReleaseInfo(project),
    releaseStatus: "unpublished",
  };
}

const HIGHLIGHT_SECTIONS = {
  en: ["New", "Improved"],
  zh: ["新增", "改进"],
} as const;
const MAX_HIGHLIGHTS = 8;
const MAX_HIGHLIGHT_LENGTH = 40;

/**
 * The bold lead-in of each top-level item in a release-notes section
 * ("- **Network proxy.** …" → "Network proxy"), from the first of the
 * language's sections that has any. The notes are bilingual: English first,
 * then Chinese after a `---` rule; each language is read on its own.
 */
export function parseReleaseHighlights(body: unknown): AppReleaseHighlights | undefined {
  if (typeof body !== "string" || !body.trim()) return undefined;
  const pick = (headings: readonly string[]): string[] => {
    for (const heading of headings) {
      const match = new RegExp(`^###\\s+${heading}\\s*$([\\s\\S]*?)(?=^#{1,3}\\s|^---\\s*$|(?![\\s\\S]))`, "m").exec(body);
      if (!match) continue;
      const titles: string[] = [];
      for (const line of match[1].split(/\r?\n/)) {
        const item = /^[-*]\s+\*\*(.+?)\*\*/.exec(line);
        if (!item) continue;
        const title = item[1].replace(/[\s.。:：!！]+$/u, "").trim();
        if (title && title.length <= MAX_HIGHLIGHT_LENGTH && !/^(security|安全)$/iu.test(title)) titles.push(title);
        if (titles.length >= MAX_HIGHLIGHTS) break;
      }
      if (titles.length > 0) return titles;
    }
    return [];
  };
  const highlights = { en: pick(HIGHLIGHT_SECTIONS.en), zh: pick(HIGHLIGHT_SECTIONS.zh) };
  return highlights.en.length > 0 || highlights.zh.length > 0 ? highlights : undefined;
}

function parseRelease(project: AppUpdateProject, raw: GitHubRelease): AppComponentReleaseInfo {
  if (raw.draft === true || raw.prerelease === true) {
    throw new Error("GitHub returned a non-stable latest release.");
  }
  if (typeof raw.tag_name !== "string" || typeof raw.html_url !== "string") {
    throw new Error("GitHub returned an invalid release payload.");
  }

  const latest = parseVersion(raw.tag_name);
  const current = parseVersion(project.currentVersion);
  if (!latest || !current) throw new Error("GitHub returned an invalid release version.");

  const highlights = parseReleaseHighlights(raw.body);
  const releaseUrl = new URL(raw.html_url);
  if (releaseUrl.protocol !== "https:" || releaseUrl.hostname !== "github.com") {
    throw new Error("GitHub returned an invalid release URL.");
  }

  return {
    project: project.id,
    name: project.name,
    repository: project.repository,
    repositoryUrl: repositoryUrl(project),
    currentVersion: current.display,
    latestVersion: latest.display,
    releaseUrl: releaseUrl.toString(),
    updateAvailable: compareAppVersions(latest.display, current.display) > 0,
    releaseStatus: "available",
    ...(highlights ? { highlights } : {}),
  };
}

export async function getLatestAppRelease(
  project: AppUpdateProject,
  options: { fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<AppComponentReleaseInfo> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(
    `https://api.github.com/repos/${project.repository}/releases/latest`,
    {
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": `pi-agent-desktop/${APP_VERSION}`,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    },
  );
  if (response.status === 404) return unpublishedRelease(project);
  if (!response.ok) throw new Error(`GitHub request failed with HTTP ${response.status}.`);
  return parseRelease(project, await response.json() as GitHubRelease);
}

export async function checkAppUpdate(
  project: AppUpdateProject,
  options: { fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<AppUpdateInfo | null> {
  const release = await getLatestAppRelease(project, options);
  if (!release.updateAvailable || !release.latestVersion || !release.releaseUrl) return null;
  return {
    project: release.project,
    name: release.name,
    currentVersion: release.currentVersion,
    latestVersion: release.latestVersion,
    releaseUrl: release.releaseUrl,
  };
}
