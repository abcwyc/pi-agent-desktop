import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentCommandError, isPromptRejectedError, sendAgentCommand } = await jiti.import("./agent-client.ts");

test("agent command HTTP rejections are distinguishable from transport failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response(
    JSON.stringify({
      error: "Authentication failed",
      code: "prompt_rejected",
      accepted: false,
    }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error instanceof AgentCommandError, true);
      assert.equal(error.status, 500);
      assert.equal(error.message, "Authentication failed");
      assert.equal(error.code, "prompt_rejected");
      assert.equal(error.accepted, false);
      assert.equal(isPromptRejectedError(error), true);
      return true;
    },
  );

  const transportError = new TypeError("connection reset");
  globalThis.fetch = async () => {
    throw transportError;
  };

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error, transportError);
      assert.equal(error instanceof AgentCommandError, false);
      assert.equal(isPromptRejectedError(error), false);
      return true;
    },
  );
});

test("a prompt refused for a missing folder carries the folder (#1422)", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const { cwdMissingError, cwdMissingBody, missingCwdFromBody } = await jiti.import("./missing-cwd.ts");
  const refusal = cwdMissingError("/old/app");
  assert.equal(refusal.message, "Directory does not exist: /old/app");
  // The route reads the thrown error by its fields, never its class.
  assert.equal(missingCwdFromBody(refusal), "/old/app");
  assert.equal(missingCwdFromBody(new Error("Directory does not exist: /old/app")), null);
  // The body the route answers with: the typed fields beside prompt_rejected.
  globalThis.fetch = async () => Response.json(
    { ...cwdMissingBody(refusal.cwd), code: "prompt_rejected", accepted: false },
    { status: 500 },
  );
  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error.missingCwd, "/old/app");
      assert.equal(isPromptRejectedError(error), true);
      return true;
    },
  );

  // Any other refusal names no folder, even with a cwd field or the same text.
  globalThis.fetch = async () => Response.json(
    { error: "Directory does not exist: /old/app", cwd: "/old/app", code: "prompt_rejected", accepted: false },
    { status: 500 },
  );
  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => error.missingCwd === undefined,
  );
  assert.equal(missingCwdFromBody({ reason: "cwd-missing", cwd: "" }), null);
  assert.equal(missingCwdFromBody(null), null);
});

test("only an explicit negative prompt acknowledgement is definitive", () => {
  assert.equal(
    isPromptRejectedError(new AgentCommandError("proxy failure", 502)),
    false,
  );
  assert.equal(
    isPromptRejectedError(new AgentCommandError("generic API failure", 500, "internal_error", false)),
    false,
  );
});
