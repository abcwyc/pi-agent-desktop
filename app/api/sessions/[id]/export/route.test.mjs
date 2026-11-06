import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeSource = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const templateSource = await readFile(
  new URL(
    "../../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.js",
    import.meta.url,
  ),
  "utf8",
);

test("the export route returns the SDK's HTML without patching it", () => {
  assert.doesNotMatch(routeSource, /patchExportHtml|replaceRequired/);
  assert.match(routeSource, /const html = readFileSync\(outputPath, "utf8"\);\s+return new Response\(html, \{/);
});

// The route used to rewrite these three helpers to survive deep linear sessions.
// Serving the template as is stays safe only while the SDK keeps them iterative.
test("the SDK export template has no recursive tree helpers", () => {
  for (const helper of ["sortChildren", "mapNodes", "markActive"]) {
    assert.doesNotMatch(templateSource, new RegExp(`function ${helper}\\(`), `${helper} is back in template.js`);
  }
});
