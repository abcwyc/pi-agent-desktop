// "Sign in with ChatGPT" needs a stable per-installation UUID (`ext_agent_host_id`
// in the authorization URL) and pi-ai refuses the login without one. The CLI
// passes it through `LoginOptions.getDeviceId`; pi-web's login route passed no
// LoginOptions at all, so every ChatGPT sign-in failed with "requires a device ID
// (UUID) for this installation" before the browser opened (#142).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { oauthLoginOptions } = await jiti.import("./oauth-login-options.ts");
const routeSource = readFileSync(
  new URL("../app/api/auth/login/[provider]/route.ts", import.meta.url),
  "utf8",
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Run against a throwaway agent dir: deviceId is persisted to its settings.json. */
async function withAgentDir(run) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-device-id-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await run(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  }
}

// SettingsManager queues its writes, so the file appears a tick after the call.
async function waitForStoredDeviceId(settingsPath, expected) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      if (settings && typeof settings === "object" && settings.deviceId === expected) return;
    } catch { /* not written yet, or caught mid-write */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`settings.json never stored deviceId ${expected}`);
}

test("login options hand pi-ai one stable device UUID and persist it globally", async () => {
  await withAgentDir(async (agentDir) => {
    const options = oauthLoginOptions();
    assert.equal(typeof options.getDeviceId, "function");

    const deviceId = options.getDeviceId();
    assert.match(deviceId, UUID);
    assert.equal(options.getDeviceId(), deviceId);

    const settingsPath = join(agentDir, "settings.json");
    await waitForStoredDeviceId(settingsPath, deviceId);

    // pi-ai calls the getter once per login; a later login reuses the stored ID.
    assert.equal(oauthLoginOptions().getDeviceId(), deviceId);
  });
});

test("a project settings file cannot choose the installation ID", async () => {
  await withAgentDir(async (agentDir) => {
    const projectDeviceId = "11111111-1111-4111-8111-111111111111";
    await mkdir(join(agentDir, ".pi"), { recursive: true });
    await writeFile(join(agentDir, ".pi", "settings.json"), JSON.stringify({ deviceId: projectDeviceId }));

    const deviceId = oauthLoginOptions().getDeviceId();
    assert.match(deviceId, UUID);
    assert.notEqual(deviceId, projectDeviceId);
  });
});

test("the login route passes the device id as the fourth login argument", () => {
  assert.match(routeSource, /import \{ oauthLoginOptions \} from "@\/lib\/oauth-login-options"/);
  assert.match(routeSource, /modelRuntime\.login\(provider, "oauth", \{[\s\S]*?\}, oauthLoginOptions\(\)\)/);
});
