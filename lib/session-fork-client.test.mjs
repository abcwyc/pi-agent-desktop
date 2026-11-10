import assert from "node:assert/strict";
import test from "node:test";
import { forkFailureMessage } from "./session-fork-client.ts";

test("a refused fork names its reason, anything else shows the server error", () => {
  assert.deepEqual(forkFailureMessage("not_found", "x"), { key: "sidebar.forkNotFound" });
  assert.deepEqual(forkFailureMessage("unsaved", "x"), { key: "sidebar.forkUnsaved" });
  assert.deepEqual(forkFailureMessage("empty", "x"), { key: "sidebar.forkEmpty" });
  assert.deepEqual(forkFailureMessage("subagent", "x"), { key: "sidebar.forkUnavailable" });
  assert.deepEqual(forkFailureMessage("request-denied", "x"), { key: "sidebar.forkUnavailable" });
  assert.deepEqual(forkFailureMessage(undefined, "boom"), { key: "sidebar.forkFailed", params: { error: "boom" } });
});
