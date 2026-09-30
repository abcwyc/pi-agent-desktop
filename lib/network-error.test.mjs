import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatNetworkError } = await jiti.import("./network-error.ts");

test("formatNetworkError unwraps undici fetch failed causes", () => {
  const leaf = Object.assign(new Error("unable to verify the first certificate"), {
    code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  });
  const wrapped = Object.assign(new TypeError("fetch failed"), { cause: leaf });
  const message = formatNetworkError(wrapped);
  assert.match(message, /fetch failed/);
  assert.match(message, /UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  assert.match(message, /NODE_EXTRA_CA_CERTS/);
});

test("formatNetworkError hints on connection refused", () => {
  const leaf = Object.assign(new Error("connect ECONNREFUSED 10.0.0.8:443"), {
    code: "ECONNREFUSED",
  });
  const wrapped = Object.assign(new TypeError("fetch failed"), { cause: leaf });
  assert.match(formatNetworkError(wrapped), /Connection refused/);
});

test("formatNetworkError keeps a plain message when there is no cause", () => {
  assert.equal(formatNetworkError(new Error("boom")), "boom");
});
