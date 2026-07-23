import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

export const componentRepositories = {
  "pi-agent-desktop": "abcwyc/pi-agent-desktop",
  pi: "earendil-works/pi",
  "pi-web": "agegr/pi-web",
};

export function normalizeVersion(value) {
  const normalized = String(value).trim().replace(/^v/i, "");
  if (!/^\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(normalized)) {
    throw new Error(`Invalid release version: ${value}`);
  }
  return normalized;
}

function versionParts(value) {
  const normalized = normalizeVersion(value);
  const [withoutBuild] = normalized.split("+");
  const [core, prerelease = ""] = withoutBuild.split("-");
  const numbers = core.split(".").map(Number);
  while (numbers.length < 3) numbers.push(0);
  return { normalized, numbers, prerelease: prerelease ? prerelease.split(".") : [] };
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const l = a.prerelease[index];
    const r = b.prerelease[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);
    if (lNumeric && rNumeric) return Number(l) < Number(r) ? -1 : 1;
    if (lNumeric !== rNumeric) return lNumeric ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export function nextPatchVersion(value) {
  const { numbers } = versionParts(value);
  return `${numbers[0]}.${numbers[1]}.${numbers[2] + 1}`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readLocalComponentVersions() {
  const [desktopPackage, appPackage, piPackage, cargoManifest] = await Promise.all([
    readJson(join(rootDir, "src-tauri", "pi-agent-desktop-package.json")),
    readJson(join(rootDir, "package.json")),
    readJson(join(rootDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json")),
    readFile(join(rootDir, "src-tauri", "Cargo.toml"), "utf8"),
  ]);
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargoManifest)?.[1];
  const versions = {
    "pi-agent-desktop": normalizeVersion(desktopPackage.version),
    pi: normalizeVersion(piPackage.version),
    "pi-web": normalizeVersion(appPackage.version),
  };
  if (cargoVersion !== versions["pi-agent-desktop"]) {
    throw new Error(`Cargo version ${cargoVersion ?? "missing"} does not match pi-agent-desktop ${versions["pi-agent-desktop"]}.`);
  }
  return versions;
}

export async function fetchLatestRelease(repository, options = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pi-agent-desktop-release-automation",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await (options.fetcher ?? fetch)(
    `https://api.github.com/repos/${repository}/releases/latest`,
    { headers },
  );
  if (response.status === 404 && options.allowMissing) return null;
  if (!response.ok) throw new Error(`${repository} release request failed with HTTP ${response.status}.`);
  const release = await response.json();
  if (typeof release.tag_name !== "string" || typeof release.html_url !== "string") {
    throw new Error(`${repository} returned an invalid release payload.`);
  }
  return {
    version: normalizeVersion(release.tag_name),
    tag: release.tag_name,
    url: release.html_url,
  };
}

export async function readRemoteComponentVersions() {
  const [piAgentDesktop, pi, piWeb] = await Promise.all([
    fetchLatestRelease(componentRepositories["pi-agent-desktop"], { allowMissing: true }),
    fetchLatestRelease(componentRepositories.pi),
    fetchLatestRelease(componentRepositories["pi-web"]),
  ]);
  return { "pi-agent-desktop": piAgentDesktop, pi, "pi-web": piWeb };
}

export function createComponentManifest(versions) {
  return {
    schemaVersion: 1,
    appVersion: versions["pi-agent-desktop"],
    components: ["pi-agent-desktop", "pi", "pi-web"].map((id) => ({
      id,
      repository: componentRepositories[id],
      version: versions[id],
    })),
  };
}
