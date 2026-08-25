import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./session-reference.ts");
}

test("extracts unique visible session labels", async () => {
  const { extractSessionReferenceLabels } = await loadSubject();
  assert.deepEqual(
    extractSessionReferenceLabels("Compare #Design with #\"Design review\" and #Design"),
    ["Design", "Design review"],
  );
});

test("formats session messages as bounded reference material", async () => {
  const { formatSessionReference } = await loadSubject();
  const reference = formatSessionReference("abc-1", "Prior work", [
    { role: "user", content: "What changed?" },
    { role: "assistant", content: [{ type: "text", text: "The parser changed." }] },
  ]);
  assert.match(reference, /<referenced-session id="abc-1" title="Prior work">/);
  assert.match(reference, /\[user\][\s\S]*What changed\?/);
  assert.match(reference, /\[assistant\][\s\S]*The parser changed\./);
  assert.match(reference, /<\/referenced-session>$/);
});
