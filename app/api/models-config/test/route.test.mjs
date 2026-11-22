import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-models-config-test-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function completionStream() {
  const chunk = {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-v4.1-flash",
    choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("Test model prepares the probe like a chat request: auth and models.json headers, an OpenCode session id", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers });
    return completionStream();
  });

  const response = await POST(new Request("http://localhost/api/models-config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({
      providerName: "open-code-go",
      provider: {
        baseUrl: "https://opencode.ai/zen/go/v1",
        api: "openai-completions",
        apiKey: "oc_sk_test",
        headers: { "X-Custom": "from-models-json" },
      },
      model: { id: "deepseek-v4.1-flash", api: "openai-completions", input: ["text"] },
    }),
  }));

  const result = await response.json();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.responseText, "OK");
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.url, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(request.headers.get("authorization"), "Bearer oc_sk_test");
  assert.equal(request.headers.get("x-custom"), "from-models-json");
  assert.match(request.headers.get("x-opencode-session") ?? "", /^[0-9a-f-]{36}$/);
});

test("Test model runs a `!command` key once", { skip: process.platform === "win32" }, async (t) => {
  const counter = join(testAgentDir, "key-command-runs");
  t.mock.method(globalThis, "fetch", async () => completionStream());
  const response = await POST(new Request("http://localhost/api/models-config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({
      providerName: "command-key",
      provider: {
        baseUrl: "https://example.test/v1",
        api: "openai-completions",
        apiKey: `!printf x >> '${counter}'; printf key`,
      },
      model: { id: "m", api: "openai-completions", input: ["text"] },
    }),
  }));
  const result = await response.json();
  assert.equal(result.ok, true, result.error);
  assert.equal(await readFile(counter, "utf8"), "x");
});

function rejectEffort(effort) {
  return new Response(JSON.stringify({
    error: {
      code: "invalid_parameter_error",
      message: `'reasoning_effort' must be one of: 'low', 'high', 'max' (got ${effort})`,
      type: "invalid_request_error",
    },
  }), { status: 400, headers: { "Content-Type": "application/json" } });
}

function probeRequest(model, provider = {}) {
  return new Request("http://localhost/api/models-config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({
      providerName: "aliyun-custom",
      provider: {
        baseUrl: "https://example.test/v1",
        api: "openai-completions",
        apiKey: "sk-test",
        ...provider,
      },
      model: { api: "openai-completions", input: ["text"], reasoning: true, ...model },
      probeThinking: true,
    }),
  });
}

test("Probe thinking levels: a refused level becomes null, an accepted xhigh/max gets an entry", async (t) => {
  const efforts = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const body = JSON.parse(await new Request(input, init).text());
    efforts.push(body.reasoning_effort ?? "(none)");
    if (body.reasoning_effort && !["low", "high", "max"].includes(body.reasoning_effort)) {
      return rejectEffort(body.reasoning_effort);
    }
    return completionStream();
  });

  const result = await (await POST(probeRequest({ id: "glm-5.3" }))).json();
  assert.equal(result.ok, true, result.error);
  // The plain request first, then one per level.
  assert.equal(efforts[0], "(none)");
  assert.deepEqual([...efforts.slice(1)].sort(), ["high", "low", "max", "medium", "minimal", "xhigh"]);

  const outcomes = Object.fromEntries(result.thinking.results.map((r) => [r.level, r.outcome]));
  assert.deepEqual(outcomes, {
    minimal: "rejected",
    low: "accepted",
    medium: "rejected",
    high: "accepted",
    xhigh: "rejected",
    max: "accepted",
  });
  assert.equal(result.thinking.applicable, true);
  assert.equal(result.thinking.allRejected, false);
  assert.equal(result.thinking.changed, true);
  assert.deepEqual(result.thinking.suggestedMap, { minimal: null, medium: null, xhigh: null, max: "max" });
});

test("Probe thinking levels sends a level's mapped value and skips a disabled level", async (t) => {
  const efforts = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const body = JSON.parse(await new Request(input, init).text());
    efforts.push(body.reasoning_effort ?? "(none)");
    return completionStream();
  });

  const result = await (await POST(probeRequest({
    id: "glm-5.3",
    thinkingLevelMap: { medium: "high", minimal: null },
  }))).json();
  assert.equal(result.ok, true, result.error);
  assert.ok(!efforts.includes("minimal"));
  assert.ok(!efforts.includes("medium"));
  const medium = result.thinking.results.find((r) => r.level === "medium");
  assert.deepEqual([medium.value, medium.outcome], ["high", "accepted"]);
  const minimal = result.thinking.results.find((r) => r.level === "minimal");
  assert.equal(minimal.outcome, "skipped");
  assert.deepEqual(result.thinking.suggestedMap, { medium: "high", minimal: null, xhigh: "xhigh", max: "max" });
});

test("Probe thinking levels does not judge a format that never sends the level", async (t) => {
  t.mock.method(globalThis, "fetch", async () => completionStream());
  const result = await (await POST(probeRequest({
    id: "qwen-template",
    compat: { thinkingFormat: "qwen-chat-template" },
  }))).json();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.thinking.applicable, false);
  assert.ok(result.thinking.results.every((r) => r.outcome === "not-sent"));
  assert.equal(result.thinking.changed, false);
});

test("Probe thinking levels keeps the map when every sent level is refused", async (t) => {
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const body = JSON.parse(await new Request(input, init).text());
    return body.reasoning_effort ? rejectEffort(body.reasoning_effort) : completionStream();
  });
  const result = await (await POST(probeRequest({ id: "no-effort" }))).json();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.thinking.allRejected, true);
  assert.equal(result.thinking.changed, false);
  assert.equal(result.thinking.suggestedMap, undefined);
});

test("Probe thinking levels stops at a failing connection", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
  });
  const result = await (await POST(probeRequest({ id: "glm-5.3" }))).json();
  assert.equal(result.ok, false);
  assert.equal(result.thinking, undefined);
  assert.equal(calls, 1);
});

test("Probe thinking levels refuses a model not marked as reasoning", async (t) => {
  t.mock.method(globalThis, "fetch", async () => completionStream());
  const result = await (await POST(probeRequest({ id: "plain", reasoning: false }))).json();
  assert.equal(result.ok, false);
  assert.match(result.error, /reasoning/);
});
