import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, jsx: { runtime: "automatic" } });
const { ModelContextWindow } = await jiti.import("./ModelContextWindow.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function render(value) {
  return renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(ModelContextWindow, { modelName: "GPT Example", effective: 272000, value, onChange() {} })));
}

test("a login model's row gets one named input whose placeholder is the window pi resolves", () => {
  const blank = render(undefined);
  assert.match(blank, /^<input [^>]*\/>$/, "no label, button or note beside the input");
  assert.match(blank, /value=""/);
  assert.match(blank, /placeholder="272000"/);
  assert.match(blank, /inputmode="numeric"/i);
  assert.match(blank, /aria-label="Context window for GPT Example"/);
  assert.match(render("500000"), /value="500000"/);
});

test("a typed draft that is not a whole number is marked without being truncated", () => {
  const html = render("500k");
  assert.match(html, /value="500k"/);
  assert.match(html, /aria-invalid="true"/);
  // A value pi accepts in models.json is not flagged, though the field would not take it typed.
  assert.doesNotMatch(render(400000.5), /aria-invalid/);
});
