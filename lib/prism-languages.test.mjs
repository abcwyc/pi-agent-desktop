import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { refractor } from "refractor/core";

const { loadPrismLanguages, prismLanguagesLoaded } = await createJiti(import.meta.url).import("./prism-languages.ts");

test("languages load into the core PrismLight renders with, aliases included", async () => {
  // PrismLight (react-syntax-highlighter/dist/esm/prism-light) highlights with refractor/core.
  assert.equal(prismLanguagesLoaded(), false);
  assert.equal(refractor.registered("typescript"), false);

  const first = loadPrismLanguages();
  assert.equal(loadPrismLanguages(), first, "one load for every caller");
  await first;

  assert.equal(prismLanguagesLoaded(), true);
  for (const name of ["typescript", "ts", "tsx", "javascript", "js", "bash", "sh", "shell", "python", "py", "json", "yaml", "yml", "css", "markup", "html", "diff", "rust", "go"]) {
    assert.equal(refractor.registered(name), true, `${name} is registered`);
  }
  const tree = refractor.highlight("const a: number = 1;", "ts");
  assert.ok(tree.children.some((node) => node.type === "element"), "ts is tokenized");
});
