import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { isThinkingLevelRefusal, refusalAllowedValues } = await jiti.import("./thinking-level-error.ts");

// The error a user hit with Aliyun Token Plan's GLM-5.3 at "medium".
const ALIYUN = `400 data: {"error":{"code":"invalid_parameter_error","param":null,"message":"'reasoning_effort' must be one of: 'low', 'high', 'max'","type":"invalid_request_error"},"id":"chatcmpl-b40e65d4"}\n\n`;

test("recognizes a 400/422 that names the effort or thinking field", () => {
  assert.equal(isThinkingLevelRefusal(ALIYUN), true);
  assert.equal(isThinkingLevelRefusal("422 Unprocessable Entity: reasoning.effort 'xhigh' is not supported"), true);
  assert.equal(isThinkingLevelRefusal("400 thinking budget_tokens must be at least 1024"), true);
});

test("leaves other errors alone", () => {
  assert.equal(isThinkingLevelRefusal("401 Incorrect API key provided"), false);
  assert.equal(isThinkingLevelRefusal("400 developer is not one of ['system', 'assistant', 'user', 'tool', 'function']"), false);
  assert.equal(isThinkingLevelRefusal("500 reasoning_effort upstream failure"), false);
  assert.equal(isThinkingLevelRefusal("Request timed out"), false);
  assert.equal(isThinkingLevelRefusal(undefined), false);
});

test("reads the accepted values the error lists", () => {
  assert.deepEqual(refusalAllowedValues(ALIYUN), ["low", "high", "max"]);
  assert.deepEqual(refusalAllowedValues("400 reasoning_effort: expected one of [low, medium, high]"), ["low", "medium", "high"]);
  assert.deepEqual(refusalAllowedValues("400 reasoning_effort must be low or high"), []);
  assert.deepEqual(refusalAllowedValues("400 reasoning_effort invalid"), []);
});
