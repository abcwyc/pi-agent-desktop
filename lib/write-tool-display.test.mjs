import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getWrittenFile, sourceLanguageFromPath } = await jiti.import("./write-tool-display.ts");

test("extracts source content from write tool calls", () => {
  assert.deepEqual(
    getWrittenFile("write", { path: "src/example.ts", content: "export const answer = 42;\n" }),
    { path: "src/example.ts", content: "export const answer = 42;\n" },
  );
  assert.deepEqual(
    getWrittenFile("tools.write", { filePath: "script.py", content: "print('ok')" }),
    { path: "script.py", content: "print('ok')" },
  );
});

test("ignores unrelated or malformed tool calls", () => {
  assert.equal(getWrittenFile("edit", { path: "x.ts", content: "text" }), null);
  assert.equal(getWrittenFile("write", { path: "x.ts" }), null);
  assert.equal(getWrittenFile("write", { path: "x.ts", content: 42 }), null);
});

test("detects common source languages from file names", () => {
  assert.equal(sourceLanguageFromPath("src/view.tsx"), "typescript");
  assert.equal(sourceLanguageFromPath("test/example.test.mjs"), "javascript");
  assert.equal(sourceLanguageFromPath("Dockerfile"), "dockerfile");
  assert.equal(sourceLanguageFromPath(".env.local"), "bash");
  assert.equal(sourceLanguageFromPath("unknown.data"), "plaintext");
});
