import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-updates-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousFetch = globalThis.fetch;
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(async () => {
  globalThis.fetch = previousFetch;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");
const { APP_VERSION } = await jiti.import("../../../lib/branding.ts");

const statePath = path.join(agentDir, "pi-web-update-check.json");
const [major, minor, patch] = APP_VERSION.split(".").map(Number);
const older = `${major}.${minor}.${Math.max(0, patch - 1)}`;
const newer = `${major}.${minor}.${patch + 1}`;

function cachedState(latestVersion, checkedAt = Date.now()) {
  return {
    version: 3,
    lastCheckedAt: { "pi-agent-desktop": checkedAt },
    releases: {
      "pi-agent-desktop": {
        project: "pi-agent-desktop",
        name: "pi-agent-desktop",
        repository: "abcwyc/pi-agent-desktop",
        repositoryUrl: "https://github.com/abcwyc/pi-agent-desktop",
        currentVersion: latestVersion,
        latestVersion,
        releaseUrl: `https://github.com/abcwyc/pi-agent-desktop/releases/tag/v${latestVersion}`,
        updateAvailable: false,
        releaseStatus: "available",
      },
    },
  };
}

function githubRelease(version) {
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/abcwyc/pi-agent-desktop/releases/tag/v${version}`,
    body: "",
    draft: false,
    prerelease: false,
  };
}

function stubGitHub(handler) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return handler();
  };
  return calls;
}

const get = async (query = "") => (await GET(new Request(`http://localhost/api/updates${query}`))).json();

test("re-checks a fresh cache whose latest release is older than the installed app", async () => {
  if (patch === 0) return; // no older patch to stand in for the stale cache
  await writeFile(statePath, JSON.stringify(cachedState(older)));
  const calls = stubGitHub(() => Response.json(githubRelease(newer)));

  const data = await get();
  assert.equal(calls.length, 1);
  assert.equal(data.components[0].latestVersion, newer);
  assert.equal(data.updates[0]?.latestVersion, newer);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).releases["pi-agent-desktop"].latestVersion, newer);
});

test("answers from a fresh cache that is not behind the installed app", async () => {
  await writeFile(statePath, JSON.stringify(cachedState(APP_VERSION)));
  const calls = stubGitHub(() => Response.json(githubRelease(newer)));

  const data = await get();
  assert.equal(calls.length, 0);
  assert.equal(data.components[0].latestVersion, APP_VERSION);
});

test("a forced refresh reports a failed GitHub request next to the cached release", async () => {
  await writeFile(statePath, JSON.stringify(cachedState(APP_VERSION)));
  stubGitHub(() => new Response("rate limited", { status: 403 }));

  const data = await get("?refresh=1");
  assert.equal(data.components[0].latestVersion, APP_VERSION);
  assert.deepEqual(data.errors?.map((entry) => entry.project), ["pi-agent-desktop"]);
});

test("a forced refresh does not settle for a background check already in flight", async () => {
  await writeFile(statePath, JSON.stringify(cachedState(APP_VERSION)));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = stubGitHub(async () => {
    await gate;
    return Response.json(githubRelease(newer));
  });

  // Background check answers from the fresh cache without asking GitHub;
  // start it, then force a refresh before it settles.
  const background = get();
  const forced = get("?refresh=1");
  release();
  const [backgroundData, forcedData] = await Promise.all([background, forced]);

  assert.equal(backgroundData.components[0].latestVersion, APP_VERSION);
  assert.equal(calls.length, 1);
  assert.equal(forcedData.components[0].latestVersion, newer);
});
