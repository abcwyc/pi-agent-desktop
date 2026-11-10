import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { registerSessionLivenessProvider } = await jiti.import("./session-liveness.ts");

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function makePromptInner(prompt) {
  return {
    sessionId: "session-1",
    isBashRunning: false,
    isStreaming: false,
    extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp", getSessionName: () => undefined, getEntries: () => [] },
    // The session-level prompt the SDK renders from its current options.
    systemPrompt: "",
    agent: { state: {} },
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    prompt,
    dispose() {},
  };
}

test("get_state waits for extension resources before returning the system prompt", async (t) => {
  let finishBinding;
  const inner = makePromptInner(() => Promise.resolve());
  inner.systemPrompt = "before extensions";
  inner.bindExtensions = () => new Promise((resolve) => {
    finishBinding = () => {
      // Binding extensions can rewrite the prompt, so get_state must read it afterwards.
      inner.systemPrompt = "after extensions";
      resolve();
    };
  });

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.beginExtensionBinding();

  let settled = false;
  const statePromise = wrapper.send({ type: "get_state" }).then((state) => {
    settled = true;
    return state;
  });
  await nextTurn();

  assert.equal(settled, false);
  finishBinding();
  const state = await statePromise;

  assert.equal(state.systemPrompt, "after extensions");
});

test("get_state reports the prompt of a session that has not run anything yet", async (t) => {
  // Pi 0.86 replays agent.state.systemPrompt from the transcript, so it is empty until the
  // first run persists a system message. Reporting that empty string made the System panel
  // claim "the prompt is empty (tools are disabled)" on every brand-new session.
  const inner = makePromptInner(() => Promise.resolve());
  Object.defineProperty(inner.agent.state, "systemPrompt", {
    get: () => "",
    enumerable: true,
  });
  inner.systemPrompt = "Pi rendered prompt";

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.systemPrompt, "Pi rendered prompt");
});

test("get_state reports active time over the wrapper's entries", async (t) => {
  const inner = makePromptInner(() => Promise.resolve());
  const entries = [
    { type: "message", id: "u", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi" } },
    { type: "message", id: "a", parentId: "u", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: [] } },
  ];
  inner.sessionManager.getEntries = () => entries;

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.totalActiveMs, 3000);
});

test("get_state keeps reporting the replayed prompt once the transcript has one", async (t) => {
  // After a run the session getter falls back to the base options, which no longer carry the
  // sections a before_agent_start handler changed for that run; the transcript still does.
  const inner = makePromptInner(() => Promise.resolve());
  Object.defineProperty(inner.agent.state, "systemPrompt", {
    get: () => "base prompt\n\nextension section",
    enumerable: true,
  });
  inner.systemPrompt = "base prompt";

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.systemPrompt, "base prompt\n\nextension section");
});

test("prompt commands wait for SDK preflight acceptance before acknowledging", async (t) => {
  let acceptPreflight;
  let finishPrompt;
  const inner = makePromptInner((_message, options) => new Promise((resolve) => {
    acceptPreflight = () => options.preflightResult("started");
    finishPrompt = resolve;
  }));
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  let acknowledged = false;
  const sending = wrapper.send({ type: "prompt", message: "hello" }).then(() => {
    acknowledged = true;
  });
  await nextTurn();

  assert.equal(acknowledged, false);
  assert.equal(wrapper.isRunning(), true);

  acceptPreflight();
  await sending;

  assert.equal(acknowledged, true);
  assert.equal(wrapper.isRunning(), true);
  assert.equal(events.some((event) => event.type === "prompt_done"), false);

  finishPrompt();
  await nextTurn();

  assert.equal(wrapper.isRunning(), false);
  assert.equal(events.filter((event) => event.type === "prompt_done").length, 1);
});

test("completion notification waits for an accepted agent run to become idle", async (t) => {
  let finishPrompt;
  let sdkListener;
  const completed = [];
  const inner = makePromptInner((_message, options) => new Promise((resolve) => {
    inner.isStreaming = true;
    options.preflightResult("started");
    finishPrompt = () => {
      inner.isStreaming = false;
      resolve();
    };
  }));
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };

  const wrapper = new AgentSessionWrapper(inner, {
    // As startRpcSession's push listener: an "aborted" outcome announces nothing.
    onAgentRunComplete: (sessionId, outcome) => { if (outcome?.status !== "aborted") completed.push(sessionId); },
  });
  t.after(() => wrapper.destroy());
  wrapper.start();

  await wrapper.send({ type: "prompt", message: "hello" });
  sdkListener({ type: "agent_start" });
  sdkListener({ type: "agent_end" });
  sdkListener({ type: "agent_end" });
  inner.isStreaming = false;
  sdkListener({ type: "agent_settled" });
  assert.deepEqual(completed, []);

  finishPrompt();
  await nextTurn();
  assert.deepEqual(completed, ["session-1"]);

  sdkListener({ type: "agent_settled" });
  assert.deepEqual(completed, ["session-1"]);
});

test("a stopped run reports an aborted outcome, and its prompt_done says it was stopped", async (t) => {
  let finishPrompt;
  let sdkListener;
  const completed = [];
  const events = [];
  const inner = makePromptInner((_message, options) => new Promise((resolve) => {
    inner.isStreaming = true;
    options.preflightResult("started");
    finishPrompt = (aborted) => {
      // The SDK settles the run before prompt() resolves.
      inner.isStreaming = false;
      sdkListener({ type: "agent_settled", aborted });
      resolve();
    };
  }));
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };

  const wrapper = new AgentSessionWrapper(inner, {
    // The fork reports every run; the push listener drops "aborted" (see startRpcSession).
    onAgentRunComplete: (_sessionId, outcome) => completed.push(outcome.status),
  });
  t.after(() => wrapper.destroy());
  wrapper.start();
  wrapper.onEvent((event) => events.push(event));

  await wrapper.send({ type: "prompt", message: "stop me" });
  sdkListener({ type: "agent_start" });
  finishPrompt(true);
  await nextTurn();
  assert.deepEqual(completed, ["aborted"]);
  assert.deepEqual(events.filter((event) => event.type === "prompt_done"), [{ type: "prompt_done", aborted: true }]);

  // The next prompt that finishes is announced again.
  await wrapper.send({ type: "prompt", message: "finish" });
  sdkListener({ type: "agent_start" });
  sdkListener({ type: "agent_end", messages: [] });
  finishPrompt(false);
  await nextTurn();
  assert.deepEqual(completed, ["aborted", "done"]);
  assert.deepEqual(events.filter((event) => event.type === "prompt_done").at(-1), { type: "prompt_done" });
});

test("completion notification covers extension-injected runs without an SSE client", (t) => {
  let sdkListener;
  const completed = [];
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };

  const wrapper = new AgentSessionWrapper(inner, {
    onAgentRunComplete: (sessionId) => completed.push(sessionId),
  });
  t.after(() => wrapper.destroy());
  wrapper.start();

  inner.isStreaming = true;
  sdkListener({ type: "agent_start" });
  sdkListener({ type: "agent_end" });
  assert.deepEqual(completed, []);

  inner.isStreaming = false;
  sdkListener({ type: "agent_settled" });
  assert.deepEqual(completed, ["session-1"]);
});

function startCompletionWrapper(t, prompt) {
  let sdkListener;
  const completed = [];
  const events = [];
  const inner = makePromptInner(prompt);
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };
  const wrapper = new AgentSessionWrapper(inner, {
    // As startRpcSession's push listener: an "aborted" outcome announces nothing.
    onAgentRunComplete: (sessionId, outcome) => { if (outcome?.status !== "aborted") completed.push(sessionId); },
  });
  t.after(() => wrapper.destroy());
  wrapper.start();
  wrapper.onEvent((event) => events.push(event));
  return { inner, wrapper, completed, events, emit: (event) => sdkListener(event) };
}

test("an extension command that starts no run announces nothing (#1345)", async (t) => {
  // pi runs the command, or an input handler swallows the text, and reports
  // "handled" without a model call.
  const { wrapper, completed, events } = startCompletionWrapper(t, (_message, options) => {
    options.preflightResult("handled");
    return Promise.resolve();
  });

  await wrapper.send({ type: "prompt", message: "/ps-probe" });
  await nextTurn();
  await wrapper.send({ type: "prompt", message: "/ps-probe" });
  await nextTurn();

  assert.deepEqual(completed, []);
  // The page still ends the command's stage on prompt_done.
  assert.equal(events.filter((event) => event.type === "prompt_done").length, 2);
});

test("a run an extension command starts is announced once, when it settles", async (t) => {
  // pi.sendUserMessage() does not wait: the command is handled and its prompt
  // resolves before the run it asked for has started.
  const { inner, wrapper, completed, emit } = startCompletionWrapper(t, (_message, options) => {
    options.preflightResult("handled");
    return Promise.resolve();
  });

  await wrapper.send({ type: "prompt", message: "/review" });
  await nextTurn();
  assert.deepEqual(completed, []);

  inner.isStreaming = true;
  emit({ type: "agent_start" });
  emit({ type: "agent_end" });
  inner.isStreaming = false;
  emit({ type: "agent_settled" });
  assert.deepEqual(completed, ["session-1"]);
});

test("a run that leaves subagents at work announces only the run after their last report (#1434)", async (t) => {
  const previousRuns = globalThis.__piSubagentRuns;
  t.after(() => { globalThis.__piSubagentRuns = previousRuns; });
  const sdk = startCompletionWrapper(t, async (_message, options) => {
    options.preflightResult("started");
    sdk.inner.isStreaming = true;
    sdk.emit({ type: "agent_start" });
    // The run starts a background subagent and ends with "started, I'll report back".
    globalThis.__piSubagentRuns = new Map([["child", { run: { sessionId: "child", parentSessionId: "session-1" } }]]);
    sdk.emit({ type: "agent_end" });
    sdk.inner.isStreaming = false;
    sdk.emit({ type: "agent_settled" });
  });

  await sdk.wrapper.send({ type: "prompt", message: "explore in the background" });
  await nextTurn();
  assert.deepEqual(sdk.completed, []);
  // The page's chime and notification read the same: this end is not the task's.
  assert.equal(sdk.events.find((event) => event.type === "agent_settled").subagentsActive, true);
  assert.deepEqual(sdk.events.filter((event) => event.type === "prompt_done"), [{ type: "prompt_done", subagentsActive: true }]);

  // The child's report starts a run of the parent's (notifyParent(), triggerTurn) once it settled.
  globalThis.__piSubagentRuns = new Map();
  sdk.events.length = 0;
  sdk.inner.isStreaming = true;
  sdk.emit({ type: "agent_start" });
  sdk.emit({ type: "agent_end" });
  sdk.inner.isStreaming = false;
  sdk.emit({ type: "agent_settled" });
  assert.deepEqual(sdk.completed, ["session-1"]);
  assert.deepEqual(sdk.events.filter((event) => event.type === "agent_settled"), [{ type: "agent_settled" }]);
});

test("a run an extension command waits for is announced once, after the command", async (t) => {
  // The handler awaits its run, which settles before pi reports "handled".
  const sdk = startCompletionWrapper(t, async (_message, options) => {
    sdk.inner.isStreaming = true;
    sdk.emit({ type: "agent_start" });
    sdk.emit({ type: "agent_end" });
    sdk.inner.isStreaming = false;
    sdk.emit({ type: "agent_settled" });
    assert.deepEqual(sdk.completed, []);
    options.preflightResult("handled");
  });

  await sdk.wrapper.send({ type: "prompt", message: "/review" });
  await nextTurn();
  assert.deepEqual(sdk.completed, ["session-1"]);
});

test("a stopped run an extension command waits for stays stopped after the command", async (t) => {
  // pi reports "handled" after the run the handler waited for has settled.
  let stopRun = true;
  const sdk = startCompletionWrapper(t, async (message, options) => {
    if (message === "/review") {
      sdk.inner.isStreaming = true;
      sdk.emit({ type: "agent_start" });
      sdk.emit({ type: "agent_end" });
      sdk.inner.isStreaming = false;
      sdk.emit({ type: "agent_settled", aborted: stopRun });
    }
    options.preflightResult("handled");
  });
  const promptDone = () => sdk.events.filter((event) => event.type === "prompt_done").at(-1);

  await sdk.wrapper.send({ type: "prompt", message: "/review" });
  await nextTurn();
  assert.deepEqual(sdk.completed, []);
  assert.deepEqual(promptDone(), { type: "prompt_done", aborted: true });

  // A command with no run of its own does not report that earlier Stop.
  await sdk.wrapper.send({ type: "prompt", message: "/ps-probe" });
  await nextTurn();
  assert.deepEqual(promptDone(), { type: "prompt_done" });

  stopRun = false;
  await sdk.wrapper.send({ type: "prompt", message: "/review" });
  await nextTurn();
  assert.deepEqual(sdk.completed, ["session-1"]);
  assert.deepEqual(promptDone(), { type: "prompt_done" });
});

test("new event listeners receive the latest active tool update", (t) => {
  let sdkListener;
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };

  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.start();

  sdkListener({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash" });
  sdkListener({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "one" }] } });
  const latest = { type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "one\ntwo" }] } };
  sdkListener(latest);

  const replayed = [];
  const unsubscribe = wrapper.onEvent((event) => replayed.push(event));
  assert.deepEqual(replayed, [latest]);

  unsubscribe();
  sdkListener({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash" });
  const afterEnd = [];
  wrapper.onEvent((event) => afterEnd.push(event));
  assert.deepEqual(afterEnd, []);
});

function startToolEventWrapper(t) {
  let sdkListener;
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.start();
  const replay = () => {
    const replayed = [];
    wrapper.onEvent((event) => replayed.push(event))();
    return replayed;
  };
  return { emit: (event) => sdkListener(event), replay };
}

test("does not replay the nested calls of a running codemode script", (t) => {
  const { emit, replay } = startToolEventWrapper(t);
  const parentStart = { type: "tool_execution_start", toolCallId: "call-1", toolName: "codemode", args: { code: "" } };
  emit(parentStart);
  emit({ type: "tool_execution_start", toolCallId: "call-1/1", toolName: "read", args: {}, parentToolCallId: "call-1" });
  emit({ type: "tool_execution_update", toolCallId: "call-1/1", toolName: "read", args: {}, partialResult: {}, parentToolCallId: "call-1" });
  const snapshot = {
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "codemode",
    partialResult: { content: [], details: { calls: [{ id: "call-1/?", name: "read", status: "running" }] } },
  };
  emit(snapshot);
  emit({ type: "tool_execution_start", toolCallId: "call-1/2", toolName: "read", args: {}, parentToolCallId: "call-1" });

  assert.deepEqual(replay(), [snapshot]);
});

test("a tool call's end also forgets calls recorded under its id", (t) => {
  const { emit, replay } = startToolEventWrapper(t);
  const other = { type: "tool_execution_start", toolCallId: "call-2", toolName: "bash", args: {} };
  emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "codemode", args: {} });
  // A nested call that reached the wrapper without its parent id.
  emit({ type: "tool_execution_start", toolCallId: "call-1/1", toolName: "read", args: {} });
  emit({ type: "tool_execution_start", toolCallId: "call-1/1/1", toolName: "read", args: {} });
  emit(other);
  emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "codemode", isError: false });

  assert.deepEqual(replay(), [other]);
});

test("tolerates a nested end after its parent ended", (t) => {
  const { emit, replay } = startToolEventWrapper(t);
  const other = { type: "tool_execution_start", toolCallId: "call-2", toolName: "bash", args: {} };
  emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "codemode", args: {} });
  emit(other);
  emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "codemode", isError: false });
  emit({ type: "tool_execution_end", toolCallId: "call-1/1", toolName: "read", isError: true, parentToolCallId: "call-1" });

  assert.deepEqual(replay(), [other]);
});

test("replays no tool call once the run has ended", (t) => {
  const { emit, replay } = startToolEventWrapper(t);
  emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} });
  emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult: {} });
  emit({ type: "agent_end", messages: [] });

  assert.deepEqual(replay(), []);
});

test("suppressed sessions do not emit completion notifications", (t) => {
  let sdkListener;
  const completed = [];
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };

  const wrapper = new AgentSessionWrapper(inner, {
    onAgentRunComplete: (sessionId) => completed.push(sessionId),
    suppressCompletionNotifications: true,
  });
  t.after(() => wrapper.destroy());
  wrapper.start();

  inner.isStreaming = true;
  sdkListener({ type: "agent_start" });
  inner.isStreaming = false;
  sdkListener({ type: "agent_settled" });
  assert.deepEqual(completed, []);
});

test("prompt commands reject when SDK preflight fails", async (t) => {
  const inner = makePromptInner(() => {
    // Pi 1 signals failure by rejecting; the callback only reports accepted dispositions.
    return Promise.reject(new Error("Authentication failed"));
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  await assert.rejects(
    wrapper.send({ type: "prompt", message: "hello" }),
    /Authentication failed/,
  );

  assert.equal(wrapper.isRunning(), false);
  assert.deepEqual(events, []);
});

test("accepted prompt failures still finish through the event stream", async (t) => {
  let failPrompt;
  const inner = makePromptInner((_message, options) => {
    options.preflightResult("started");
    return new Promise((_resolve, reject) => {
      failPrompt = () => reject(new Error("post-accept failure"));
    });
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  await wrapper.send({ type: "prompt", message: "hello" });
  failPrompt();
  await nextTurn();

  assert.deepEqual(events.map((event) => event.type), ["prompt_error", "prompt_done"]);
});

test("queued prompt commands forward their streaming behavior and acknowledge acceptance", async (t) => {
  let receivedOptions;
  const inner = makePromptInner((_message, options) => {
    receivedOptions = options;
    options.preflightResult("queued");
    return Promise.resolve();
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  await wrapper.send({
    type: "prompt",
    message: "next",
    streamingBehavior: "followUp",
  });
  await nextTurn();

  assert.equal(receivedOptions.streamingBehavior, "followUp");
  assert.equal(receivedOptions.source, "rpc");
  assert.equal(wrapper.isRunning(), false);
  assert.deepEqual(events, []);
});

test("an exact system prompt is reported by get_state without touching the SDK prompt state", async (t) => {
  // Since Pi 0.86 the SDK prompt state is a getter replayed from the transcript.
  // The exact prompt reaches the model through before_agent_start instead, so
  // the wrapper must never assign it, even around prompt preflight.
  const inner = makePromptInner((_message, options) => {
    options.preflightResult("started");
    return Promise.resolve();
  });
  Object.defineProperty(inner.agent.state, "systemPrompt", {
    get: () => "Pi structured sections",
    enumerable: true,
  });
  const wrapper = new AgentSessionWrapper(inner, {
    exactSystemPrompt: () => "context prompt",
    chatOnly: true,
  });
  t.after(() => wrapper.destroy());

  await wrapper.send({ type: "prompt", message: "hello" });
  await nextTurn();

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.systemPrompt, "context prompt");
  assert.equal(inner.agent.state.systemPrompt, "Pi structured sections");
  assert.equal(inner.agent.prepareNextTurnWithContext, undefined);
});

test("prompt admission waits for the preceding preflight and keeps overlapping runs counted", async (t) => {
  let callCount = 0;
  let acceptFirst;
  let finishFirst;
  const inner = makePromptInner((_message, options) => {
    callCount += 1;
    if (callCount === 1) {
      return new Promise((resolve) => {
        acceptFirst = () => {
          inner.isStreaming = true;
          options.preflightResult("started");
        };
        finishFirst = () => {
          inner.isStreaming = false;
          resolve();
        };
      });
    }

    assert.equal(inner.isStreaming, true);
    options.preflightResult("started");
    return Promise.resolve();
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  const first = wrapper.send({ type: "prompt", message: "first" });
  await nextTurn();
  const queued = wrapper.send({
    type: "prompt",
    message: "queued",
    streamingBehavior: "followUp",
  });
  await nextTurn();

  assert.equal(callCount, 1);
  acceptFirst();
  await Promise.all([first, queued]);
  await nextTurn();

  assert.equal(callCount, 2);
  assert.equal((await wrapper.send({ type: "get_state" })).isPromptRunning, true);

  finishFirst();
  await nextTurn();

  assert.equal((await wrapper.send({ type: "get_state" })).isPromptRunning, false);
});

test("prompt admission continues after the preceding preflight rejects", async (t) => {
  let callCount = 0;
  let rejectFirst;
  const inner = makePromptInner((_message, options) => {
    callCount += 1;
    if (callCount === 1) {
      return new Promise((_resolve, reject) => {
        rejectFirst = () => {
          reject(new Error("first rejected"));
        };
      });
    }
    options.preflightResult("started");
    return Promise.resolve();
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  const firstRejected = assert.rejects(
    wrapper.send({ type: "prompt", message: "first" }),
    /first rejected/,
  );
  await nextTurn();
  const second = wrapper.send({ type: "prompt", message: "second" });
  await nextTurn();
  assert.equal(callCount, 1);

  rejectFirst();
  await Promise.all([firstRejected, second]);

  assert.equal(callCount, 2);
  assert.equal(wrapper.isRunning(), false);
});

test("a failing event listener cannot reject prompt completion", async (t) => {
  const originalConsoleError = console.error;
  t.after(() => {
    console.error = originalConsoleError;
  });
  console.error = () => {};

  const inner = makePromptInner((_message, options) => {
    options.preflightResult("started");
    return Promise.resolve();
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const delivered = [];
  wrapper.onEvent(() => {
    throw new Error("listener failed");
  });
  wrapper.onEvent((event) => delivered.push(event.type));

  await wrapper.send({ type: "prompt", message: "hello" });
  await nextTurn();

  assert.deepEqual(delivered, ["prompt_done"]);
  assert.equal(wrapper.isRunning(), false);
});

test("session shutdown notifies extensions before disposing the SDK session", async () => {
  const calls = [];
  const inner = {
    isBashRunning: false,
    extensionRunner: {
      async emit(event) {
        calls.push(["emit", event]);
      },
    },
    dispose() {
      calls.push(["dispose"]);
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push(["destroy"]));

  await Promise.all([wrapper.shutdown(), wrapper.shutdown()]);

  assert.deepEqual(calls, [
    ["emit", { type: "session_shutdown", reason: "quit" }],
    ["dispose"],
    ["destroy"],
  ]);
  assert.equal(wrapper.isAlive(), false);
});

test("session shutdown still disposes the SDK session when an extension fails", async () => {
  const calls = [];
  const inner = {
    isBashRunning: false,
    extensionRunner: {
      async emit() {
        calls.push("emit");
        throw new Error("shutdown hook failed");
      },
    },
    dispose() {
      calls.push("dispose");
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push("destroy"));

  await assert.rejects(wrapper.shutdown(), /shutdown hook failed/);

  assert.deepEqual(calls, ["emit", "dispose", "destroy"]);
  assert.equal(wrapper.isAlive(), false);
});

test("destroy notifies event listeners so attached SSE streams can close", () => {
  const inner = {
    isBashRunning: false,
    extensionRunner: {},
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  const events = [];
  wrapper.onEvent((event) => events.push(event.type));
  wrapper.destroy();
  assert.deepEqual(events, ["session_shutdown"]);
});

test("a listener that unsubscribes while handling an event does not hide it from the next one", () => {
  const inner = {
    isBashRunning: false,
    extensionRunner: {},
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  const received = [];
  const stopFirst = wrapper.onEvent((event) => {
    received.push(["first", event.type]);
    stopFirst();
  });
  wrapper.onEvent((event) => received.push(["second", event.type]));
  wrapper.onEvent((event) => received.push(["third", event.type]));

  wrapper.destroy();

  assert.deepEqual(received, [
    ["first", "session_shutdown"],
    ["second", "session_shutdown"],
    ["third", "session_shutdown"],
  ]);
});

test("direct destruction disposes the SDK session before unregistering the wrapper", () => {
  const calls = [];
  const inner = {
    isBashRunning: false,
    extensionRunner: {},
    dispose() {
      calls.push("dispose");
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push("destroy"));

  wrapper.destroy();
  wrapper.destroy();

  assert.deepEqual(calls, ["dispose", "destroy"]);
  assert.equal(wrapper.isAlive(), false);
});

test("direct destruction emits session_shutdown before dispose when extensions are present", async () => {
  const calls = [];
  const inner = {
    isBashRunning: false,
    extensionRunner: {
      async emit(event) {
        calls.push(["emit", event]);
      },
    },
    dispose() {
      calls.push(["dispose"]);
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push(["destroy"]));

  wrapper.destroy();
  wrapper.destroy();

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    ["emit", { type: "session_shutdown", reason: "quit" }],
    ["dispose"],
    ["destroy"],
  ]);
  assert.equal(wrapper.isAlive(), false);
});

test("direct destruction still disposes when session_shutdown throws synchronously", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = [];
  const inner = {
    isBashRunning: false,
    extensionRunner: {
      emit() {
        throw new Error("shutdown hook failed");
      },
    },
    dispose() {
      calls.push("dispose");
    },
  };
  const wrapper = new AgentSessionWrapper(inner);

  wrapper.destroy();
  await nextTurn();

  assert.deepEqual(calls, ["dispose"]);
  assert.equal(wrapper.isAlive(), false);
});

test("idle timer preserves extension-owned session work until it becomes inactive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  let active = true;
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = () => () => {};
  inner.extensionRunner = {
    async emit(event) {
      calls.push(["emit", event]);
    },
  };
  inner.dispose = () => calls.push(["dispose"]);
  const release = registerSessionLivenessProvider({
    name: "test-extension",
    sessionId: "session-1",
    isActive: () => active,
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(release);
  t.after(() => wrapper.destroy());
  wrapper.start();

  t.mock.timers.tick(10 * 60 * 1000);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  assert.deepEqual(calls, []);

  active = false;
  t.mock.timers.tick(10 * 60 * 1000);
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
  assert.deepEqual(calls, [
    ["emit", { type: "session_shutdown", reason: "quit" }],
    ["dispose"],
  ]);
});

test("idle timer preserves active work but reaps a run stuck after Stop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  let resolveAbort;
  const inner = makePromptInner(() => Promise.resolve());
  inner.isStreaming = true;
  inner.subscribe = () => () => {};
  inner.abort = () => {
    calls.push(["abort"]);
    return new Promise((resolve) => { resolveAbort = resolve; });
  };
  inner.extensionRunner = {
    async emit(event) {
      calls.push(["emit", event]);
    },
  };
  inner.dispose = () => calls.push(["dispose"]);
  const release = registerSessionLivenessProvider({
    name: "test-extension",
    sessionId: "session-1",
    isActive: () => true,
  });
  const wrapper = new AgentSessionWrapper(inner);
  t.after(release);
  t.after(() => wrapper.destroy());
  wrapper.start();

  t.mock.timers.tick(10 * 60 * 1000);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  assert.deepEqual(calls, []);

  const stopping = wrapper.send({ type: "abort" });
  await nextTurn();
  await wrapper.send({ type: "get_state" });
  t.mock.timers.tick(10 * 60 * 1000);
  await nextTurn();

  assert.equal(wrapper.isAlive(), false);
  assert.deepEqual(calls, [
    ["abort"],
    ["emit", { type: "session_shutdown", reason: "quit" }],
    ["dispose"],
  ]);

  inner.isStreaming = false;
  resolveAbort();
  await stopping;
});

test("direct bash commands use sanitized project operations with current shell settings", async (t) => {
  let received;
  let shellPath = "/bin/bash";
  const inner = {
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    extensionRunner: {},
    settingsManager: {
      getShellPath: () => shellPath,
    },
    sessionManager: {
      getCwd: () => process.cwd(),
      getSessionFile: () => undefined,
    },
    agent: { state: {} },
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    executeBash: async (command, _onChunk, options) => {
      received = { command, options };
      return { output: "", exitCode: 0 };
    },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());

  shellPath = "/custom/bash";
  await wrapper.send({
    type: "bash",
    command: "echo ready",
    excludeFromContext: true,
  });

  assert.equal(received.command, "echo ready");
  assert.equal(received.options.excludeFromContext, true);
  assert.equal(typeof received.options.operations.exec, "function");
});

test("completion reports how the run ended, using the last agent_end", (t) => {
  let sdkListener;
  const completed = [];
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };
  const wrapper = new AgentSessionWrapper(inner, {
    onAgentRunComplete: (sessionId, outcome) => completed.push(outcome),
  });
  t.after(() => wrapper.destroy());
  wrapper.start();

  const run = (stopReason, errorMessage) => {
    inner.isStreaming = true;
    sdkListener({ type: "agent_start" });
    sdkListener({
      type: "agent_end",
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [], stopReason, errorMessage }],
    });
    inner.isStreaming = false;
    sdkListener({ type: "agent_settled" });
  };

  run("stop");
  run("error", "429 rate limited");
  run("aborted");
  // An auto-retry: the first attempt fails, the retry succeeds before the run settles.
  inner.isStreaming = true;
  sdkListener({ type: "agent_start" });
  sdkListener({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "overloaded" }] });
  sdkListener({ type: "agent_start" });
  sdkListener({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
  inner.isStreaming = false;
  sdkListener({ type: "agent_settled" });

  assert.deepEqual(completed, [
    { status: "done" },
    { status: "failed", error: "429 rate limited" },
    { status: "aborted" },
    { status: "done" },
  ]);
});

test("a blocking extension dialog reports that the session is waiting", async (t) => {
  const waiting = [];
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = () => () => {};
  const wrapper = new AgentSessionWrapper(inner, {
    onAttentionNeeded: (sessionId, prompt) => waiting.push([sessionId, prompt]),
  });
  t.after(() => wrapper.destroy());
  wrapper.start();

  const ui = wrapper["createExtensionUiContext"]();
  ui.notify("just so you know", "info");
  const answer = ui.confirm("Delete build/?", "This removes 3 files.", { timeout: 50 });
  assert.deepEqual(waiting, [["session-1", "Delete build/?"]]);
  assert.equal(await answer, false);

  const quiet = new AgentSessionWrapper(inner, {
    onAttentionNeeded: (sessionId, prompt) => waiting.push([sessionId, prompt]),
    suppressCompletionNotifications: true,
  });
  t.after(() => quiet.destroy());
  await quiet["createExtensionUiContext"]().confirm("Sub-agent question", "", { timeout: 10 });
  assert.equal(waiting.length, 1, "sub-agent sessions stay quiet");
});

test("the task snapshot reports the step, the open dialog and the last outcome", async (t) => {
  let sdkListener;
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };
  const wrapper = new AgentSessionWrapper(inner, {});
  t.after(() => wrapper.destroy());
  wrapper.start();

  assert.deepEqual(wrapper.getTaskSnapshot(), {
    sessionId: "session-1", running: false, runStartedAt: null, activity: null, waiting: [], lastRun: null,
  });

  inner.isStreaming = true;
  sdkListener({ type: "agent_start" });
  assert.deepEqual(wrapper.getTaskSnapshot().activity, { kind: "thinking" });
  assert.equal(typeof wrapper.getTaskSnapshot().runStartedAt, "number");
  sdkListener({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} });
  assert.deepEqual(wrapper.getTaskSnapshot().activity, { kind: "tool", name: "bash" });
  sdkListener({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {} });
  sdkListener({ type: "auto_retry_start" });
  assert.deepEqual(wrapper.getTaskSnapshot().activity, { kind: "retrying" });

  const answer = wrapper["createExtensionUiContext"]().select("Which branch?", ["a", "b"], { timeout: 50 });
  assert.deepEqual(wrapper.getTaskSnapshot().waiting, [{ method: "select", prompt: "Which branch?" }]);
  await answer;
  assert.deepEqual(wrapper.getTaskSnapshot().waiting, []);

  sdkListener({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "boom" }] });
  inner.isStreaming = false;
  sdkListener({ type: "agent_settled" });
  const after = wrapper.getTaskSnapshot();
  assert.equal(after.running, false);
  assert.equal(after.runStartedAt, null);
  assert.deepEqual(after.lastRun.outcome, { status: "failed", error: "boom" });
});

test("a custom extension dialog asks for attention once, not on every redraw", async (t) => {
  const waiting = [];
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = () => () => {};
  const wrapper = new AgentSessionWrapper(inner, {
    onAttentionNeeded: (sessionId, prompt) => waiting.push([sessionId, prompt]),
  });
  t.after(() => wrapper.destroy());
  wrapper.start();

  let tui;
  let close;
  const pending = wrapper["createExtensionUiContext"]().custom((ui, _theme, _keys, done) => {
    tui = ui;
    close = done;
    return { render: () => ["Pick one"], handleInput() {} };
  });
  while (!close) await nextTurn();
  await nextTurn();
  const [id] = wrapper["activeCustomUis"].keys();
  tui.requestRender?.();
  wrapper["handleExtensionUiInput"](id, "j");
  wrapper["handleExtensionUiInput"](id, "k");
  assert.deepEqual(waiting, [["session-1", ""]]);
  close("a");
  assert.equal(await pending, "a");
});

test("a finished run's outcome outlives the wrapper's idle eviction", async (t) => {
  const { getRpcTaskSnapshots, resetRecentRunOutcomesForTests } = await jiti.import("./rpc-manager.ts");
  resetRecentRunOutcomesForTests();
  t.after(() => resetRecentRunOutcomesForTests());
  let sdkListener;
  const inner = makePromptInner(() => Promise.resolve());
  inner.sessionId = "evicted-session";
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };
  const wrapper = new AgentSessionWrapper(inner, {});
  wrapper.start();

  inner.isStreaming = true;
  sdkListener({ type: "agent_start" });
  sdkListener({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "quota" }] });
  inner.isStreaming = false;
  sdkListener({ type: "agent_settled" });
  wrapper.destroy();

  const snapshot = getRpcTaskSnapshots().find((entry) => entry.sessionId === "evicted-session");
  assert.ok(snapshot, "the outcome is still reported after eviction");
  assert.equal(snapshot.running, false);
  assert.deepEqual(snapshot.lastRun.outcome, { status: "failed", error: "quota" });
});

test("Stop during a retry back-off reports aborted, not failed", (t) => {
  let sdkListener;
  const completed = [];
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = (listener) => {
    sdkListener = listener;
    return () => {};
  };
  const wrapper = new AgentSessionWrapper(inner, { onAgentRunComplete: (_id, outcome) => completed.push(outcome) });
  t.after(() => wrapper.destroy());
  wrapper.start();

  // agent-session.js: abortRetry → _finishCancelledRetry → auto_retry_end, no new agent_end;
  // _emitAgentSettled reports { aborted: _agentRunAbortRequested }.
  inner.isStreaming = true;
  sdkListener({ type: "agent_start" });
  sdkListener({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "429" }] });
  sdkListener({ type: "auto_retry_start" });
  sdkListener({ type: "auto_retry_end", success: false });
  inner.isStreaming = false;
  sdkListener({ type: "agent_settled", aborted: true });

  // A later run whose agent_end carries no assistant message does not inherit "aborted".
  inner.isStreaming = true;
  sdkListener({ type: "agent_start" });
  sdkListener({ type: "agent_end", messages: [] });
  inner.isStreaming = false;
  sdkListener({ type: "agent_settled", aborted: false });

  assert.deepEqual(completed, [{ status: "aborted" }, { status: "done" }]);
});

test("'running since' stays put while the run waits before agent_start", (t) => {
  const inner = makePromptInner(() => Promise.resolve());
  inner.subscribe = () => () => {};
  const wrapper = new AgentSessionWrapper(inner, {});
  t.after(() => wrapper.destroy());
  wrapper.start();
  inner.isStreaming = true; // running, no agent_start yet (MCP prepare, preflight)
  const first = wrapper.getTaskSnapshot().runStartedAt;
  const later = Date.now() + 5000;
  const realNow = Date.now;
  Date.now = () => later;
  try {
    assert.equal(wrapper.getTaskSnapshot().runStartedAt, first);
  } finally {
    Date.now = realNow;
  }
});
