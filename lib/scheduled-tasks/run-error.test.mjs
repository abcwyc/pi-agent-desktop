import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { describeRunError } = await createJiti(import.meta.url).import("./run-error.ts");
const t = (key, params) => (params ? `${key}${JSON.stringify(params)}` : key);

test("an error with a code is translated, with its parameters", () => {
  assert.equal(describeRunError({ error: "Stopped after reaching the 30 minute limit", errorCode: "time-limit", errorParams: { minutes: 30 } }, t), 'scheduled.runError.timeLimit{"minutes":30}');
  assert.equal(describeRunError({ errorCode: "interrupted" }, t), "scheduled.runError.interrupted");
  assert.equal(describeRunError({ errorCode: "stopped" }, t), "scheduled.runError.stopped");
  assert.equal(describeRunError({ errorCode: "cwd-missing", errorParams: { path: "/x" } }, t), 'scheduled.runError.cwdMissing{"path":"/x"}');
});

test("an error without a code, such as a provider's message, is shown as it came", () => {
  assert.equal(describeRunError({ error: "500: upstream exploded" }, t), "500: upstream exploded");
  assert.equal(describeRunError({}, t), "");
});

test("a code this build does not know falls back to the English text", () => {
  assert.equal(describeRunError({ error: "Something new", errorCode: "from-the-future" }, t), "Something new");
});
