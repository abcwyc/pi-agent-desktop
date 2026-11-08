import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-session-name-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

test.after(() => rm(agentDir, { recursive: true, force: true }));

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const sessionListVersion = () => globalThis.__piSessionListGeneration ?? 0;

// Extensions that name sessions (pi-autoname, pi's examples/extensions/session-name.ts)
// call pi.setSessionName() whenever their title is ready, often after the run's agent_end.
test("a session name an extension sets after its run refreshes the session list (#1237)", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-session-name-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let finishTitle;
  const title = new Promise((resolve) => { finishTitle = resolve; });
  const autoTitle = (pi) => {
    pi.on("agent_end", () => {
      // Generated in the background: the run does not wait for it.
      void title.then((name) => pi.setSessionName(name));
    });
  };

  const faux = fauxProvider({ models: [{ id: "faux-session-name" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [autoTitle],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel("faux-session-name"),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader,
  });
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();

  faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
  await session.prompt("fix the flaky login test");
  const afterRun = sessionListVersion();
  assert.equal(session.sessionManager.getSessionName(), undefined);

  finishTitle("Fix the flaky login test");
  await nextTurn();
  assert.equal(session.sessionManager.getSessionName(), "Fix the flaky login test");
  // The sidebar refetches its list when this version moves (GET /api/agent/running).
  assert.ok(sessionListVersion() > afterRun);
});
