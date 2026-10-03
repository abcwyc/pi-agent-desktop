import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

// pi's /tree asks "Summarize branch?"; navigate_tree used to drop every option, so a
// branch switch in the browser could never carry the abandoned branch's work along.

function makeInner(navigateTree) {
  const calls = { navigate: [], abortBranchSummary: 0 };
  const inner = {
    sessionId: "session-1",
    isBashRunning: false,
    isStreaming: false,
    extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp", getEntries: () => [] },
    systemPrompt: "",
    agent: { state: {} },
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getActiveToolNames: () => [],
    navigateTree: async (targetId, options) => {
      calls.navigate.push({ targetId, options });
      return navigateTree(targetId, options);
    },
    abortBranchSummary: () => { calls.abortBranchSummary += 1; },
    dispose() {},
  };
  return { inner, calls };
}

test("navigate_tree forwards summarize and trimmed custom instructions", async (t) => {
  const { inner, calls } = makeInner(async () => ({ cancelled: false }));
  const wrapper = new AgentSessionWrapper(inner, { chatOnly: true });
  t.after(() => wrapper.destroy());

  const result = await wrapper.send({
    type: "navigate_tree",
    targetId: "e1",
    summarize: true,
    customInstructions: "  keep the API decisions  ",
  });

  assert.deepEqual(result, { cancelled: false });
  assert.deepEqual(calls.navigate, [{
    targetId: "e1",
    options: { summarize: true, customInstructions: "keep the API decisions" },
  }]);
});

test("a plain navigate_tree still asks for no summary", async (t) => {
  const { inner, calls } = makeInner(async () => ({ cancelled: false }));
  const wrapper = new AgentSessionWrapper(inner, { chatOnly: true });
  t.after(() => wrapper.destroy());

  await wrapper.send({ type: "navigate_tree", targetId: "e1", customInstructions: "   " });

  assert.deepEqual(calls.navigate[0].options, {});
});

test("a stopped summary reports aborted so the browser stays on its branch", async (t) => {
  const { inner, calls } = makeInner(async () => ({ cancelled: true, aborted: true }));
  const wrapper = new AgentSessionWrapper(inner, { chatOnly: true });
  t.after(() => wrapper.destroy());

  assert.equal(await wrapper.send({ type: "abort_branch_summary" }), null);
  assert.equal(calls.abortBranchSummary, 1);
  assert.deepEqual(
    await wrapper.send({ type: "navigate_tree", targetId: "e1", summarize: true }),
    { cancelled: true, aborted: true },
  );
});
