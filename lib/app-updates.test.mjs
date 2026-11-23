import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  APP_UPDATE_CHECK_INTERVAL_MS,
  checkAppUpdate,
  compareAppVersions,
  getNextAppUpdateCheckAt,
  getLatestAppRelease,
  isAppUpdateDue,
} = await jiti.import("./app-updates.ts");

const project = {
  id: "pi-agent-desktop",
  name: "Pi Agent",
  repository: "abcwyc/pi-agent-desktop",
  currentVersion: "0.8.5",
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("compares stable and prerelease semantic versions", () => {
  assert.equal(compareAppVersions("0.81.1", "0.81.0"), 1);
  assert.equal(compareAppVersions("v1.0.0", "1.0.0"), 0);
  assert.equal(compareAppVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareAppVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareAppVersions("0.1", "0.1.0"), 0);
  assert.throws(() => compareAppVersions("latest", "1.0.0"), /Invalid version/);
});

test("returns a newer official GitHub release", async () => {
  let requestedUrl = "";
  const update = await checkAppUpdate(project, {
    fetcher: async (url) => {
      requestedUrl = url;
      return jsonResponse({
        tag_name: "v0.8.6",
        html_url: "https://github.com/abcwyc/pi-agent-desktop/releases/tag/v0.8.6",
        draft: false,
        prerelease: false,
      });
    },
  });

  assert.match(requestedUrl, /repos\/abcwyc\/pi-agent-desktop\/releases\/latest$/);
  assert.deepEqual(update, {
    project: "pi-agent-desktop",
    name: "Pi Agent",
    currentVersion: "0.8.5",
    latestVersion: "0.8.6",
    releaseUrl: "https://github.com/abcwyc/pi-agent-desktop/releases/tag/v0.8.6",
  });
});

test("does not report the installed release or prereleases", async () => {
  const current = await checkAppUpdate(project, {
    fetcher: async () => jsonResponse({
      tag_name: "v0.8.5",
      html_url: "https://github.com/abcwyc/pi-agent-desktop/releases/tag/v0.8.5",
    }),
  });
  assert.equal(current, null);

  await assert.rejects(
    checkAppUpdate(project, {
      fetcher: async () => jsonResponse({
        tag_name: "v0.9.0-beta.1",
        html_url: "https://github.com/abcwyc/pi-agent-desktop/releases/tag/v0.9.0-beta.1",
        prerelease: true,
      }),
    }),
    /non-stable/i,
  );
});

test("represents a repository without releases", async () => {
  const appProject = {
    id: "pi-agent-desktop",
    name: "pi-agent-desktop",
    repository: "abcwyc/pi-agent-desktop",
    currentVersion: "0.1",
  };
  const release = await getLatestAppRelease(appProject, {
    fetcher: async () => jsonResponse({}, 404),
  });

  assert.deepEqual(release, {
    project: "pi-agent-desktop",
    name: "pi-agent-desktop",
    repository: "abcwyc/pi-agent-desktop",
    repositoryUrl: "https://github.com/abcwyc/pi-agent-desktop",
    currentVersion: "0.1",
    latestVersion: null,
    releaseUrl: null,
    updateAvailable: false,
    releaseStatus: "unpublished",
  });
});

test("rejects failed requests and untrusted release URLs", async () => {
  await assert.rejects(
    checkAppUpdate(project, { fetcher: async () => jsonResponse({}, 503) }),
    /HTTP 503/,
  );
  await assert.rejects(
    checkAppUpdate(project, {
      fetcher: async () => jsonResponse({
        tag_name: "v0.8.6",
        html_url: "https://example.com/fake-release",
      }),
    }),
    /invalid release URL/i,
  );
});

test("checks the desktop release no more than once per day", () => {
  assert.equal(APP_UPDATE_CHECK_INTERVAL_MS, 24 * 60 * 60 * 1000);
  const now = Date.UTC(2026, 6, 22);
  assert.equal(isAppUpdateDue(undefined, now), true);
  assert.equal(isAppUpdateDue(now - APP_UPDATE_CHECK_INTERVAL_MS + 1, now), false);
  assert.equal(isAppUpdateDue(now - APP_UPDATE_CHECK_INTERVAL_MS, now), true);
  assert.equal(isAppUpdateDue(now + 1, now), true);

  assert.equal(getNextAppUpdateCheckAt({ "pi-agent-desktop": now }, now), now + APP_UPDATE_CHECK_INTERVAL_MS);
  assert.equal(getNextAppUpdateCheckAt({}, now), now);
});
