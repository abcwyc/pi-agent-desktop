import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { SavedFileCard, isSavedFileInfo } = await jiti.import("./SavedFileCard.tsx");

test("a saved file shows its name, size and a way to reveal it", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null,
      React.createElement(SavedFileCard, { file: { path: "/Users/me/Downloads/a.md", name: "a.md", size: 2048 } })),
  );
  assert.match(html, /a\.md/);
  assert.match(html, /Saved to Downloads · 2\.0 KB/);
  assert.match(html, /Show in folder/);
});

test("only a result with a path, a name and a size is treated as a saved file", () => {
  assert.equal(isSavedFileInfo({ path: "/x", name: "x", size: 1 }), true);
  assert.equal(isSavedFileInfo({ path: "/x", name: "x" }), false);
  assert.equal(isSavedFileInfo(null), false);
  assert.equal(isSavedFileInfo(undefined), false);
});
