import assert from "node:assert/strict";
import test from "node:test";
import {
  HTML_PREVIEW_MAX_HEIGHT,
  HTML_PREVIEW_MIN_HEIGHT,
  HTML_PREVIEW_SANDBOX,
  HTML_PREVIEW_ERROR_MESSAGE,
  HTML_PREVIEW_OPEN_MESSAGE,
  buildHtmlPreviewDocument,
  clampHtmlPreviewHeight,
  htmlPreviewFollowsTheme,
  htmlPreviewDownloadSource,
  htmlPreviewHasActiveContent,
  HTML_PREVIEW_MAX_PROMPT_LENGTH,
  HTML_PREVIEW_PROMPT_MESSAGE,
  HTML_PREVIEW_READY_MESSAGE,
  framePromptText,
  HTML_PREVIEW_THEME_MESSAGE,
  htmlPreviewKind,
  isRunnableReactComponent,
  reactImportMap,
  reactImportSpecifiers,
} from "./html-preview.ts";

test("previews only complete HTML documents", () => {
  assert.equal(htmlPreviewKind("html", "<!DOCTYPE html><html><body>x</body></html>"), "html");
  assert.equal(htmlPreviewKind("HTML", "\n  <html lang=\"en\"><body/></html>"), "html");
  assert.equal(htmlPreviewKind("html", "<!-- demo -->\n<!doctype html>\n<p>x</p>"), "html");
  assert.equal(htmlPreviewKind("html", "<div class=\"card\">fragment</div>"), null);
  assert.equal(htmlPreviewKind("html", "<header>not html root</header>"), null);
  assert.equal(htmlPreviewKind("js", "<!DOCTYPE html><html></html>"), null);
  assert.equal(htmlPreviewKind("", "<!DOCTYPE html><html></html>"), null);
});

test("previews SVG images from svg, xml and html fences", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
  assert.equal(htmlPreviewKind("svg", svg), "svg");
  assert.equal(htmlPreviewKind("xml", `<?xml version="1.0"?>\n${svg}`), "svg");
  assert.equal(htmlPreviewKind("html", svg), "svg");
  assert.equal(htmlPreviewKind("xml", "<root/>"), null);
  assert.equal(htmlPreviewKind("svg", "<path d=\"M0 0\"/>"), null);
});

test("never grants the frame same-origin access", () => {
  assert.match(HTML_PREVIEW_SANDBOX, /\ballow-scripts\b/);
  assert.doesNotMatch(HTML_PREVIEW_SANDBOX, /allow-same-origin/);
});

test("injects the bootstrap inside <head> without breaking the doctype", () => {
  const doc = buildHtmlPreviewDocument("html", "<!DOCTYPE html><html><head><title>t</title></head><body><header>h</header></body></html>");
  assert.ok(doc.startsWith("<!DOCTYPE html><html><head><script>"));
  assert.match(doc, /<header>h<\/header>/);
  assert.equal(doc.match(/pi-html-preview:size/g).length, 1);

  const noHead = buildHtmlPreviewDocument("html", "<!doctype html>\n<html lang=\"en\"><body>x</body></html>");
  assert.match(noHead, /^<!doctype html>\n<html lang="en"><script>/);

  const bare = buildHtmlPreviewDocument("html", "<!doctype html><p>x</p>");
  assert.match(bare, /^<!doctype html><script>/);
});

test("wraps SVG in a standards-mode document", () => {
  const doc = buildHtmlPreviewDocument("svg", "<svg><circle r=\"4\"/></svg>");
  assert.ok(doc.startsWith("<!DOCTYPE html>"));
  assert.match(doc, /<body><svg><circle r="4"\/><\/svg><\/body>/);
});

test("clamps reported heights", () => {
  assert.equal(clampHtmlPreviewHeight(10), HTML_PREVIEW_MIN_HEIGHT);
  assert.equal(clampHtmlPreviewHeight(100000), HTML_PREVIEW_MAX_HEIGHT);
  assert.equal(clampHtmlPreviewHeight(200.2), 201);
  assert.equal(typeof clampHtmlPreviewHeight(Number.NaN), "number");
});

const theme = { scheme: "dark", background: "rgb(28, 28, 30)", text: "rgb(245, 245, 247)" };

test("only unstyled pages follow the app theme", () => {
  assert.equal(htmlPreviewFollowsTheme("html", "<!doctype html><h1>Plain</h1><style>h1{font-size:2em;margin:0}</style>"), true);
  assert.equal(htmlPreviewFollowsTheme("html", "<!doctype html><style>body{background:#fff}</style>"), false);
  assert.equal(htmlPreviewFollowsTheme("html", "<!doctype html><p style=\"color: #333\">x</p>"), false);
  assert.equal(htmlPreviewFollowsTheme("html", "<!doctype html><body bgcolor=white>"), false);
  assert.equal(htmlPreviewFollowsTheme("html", "<!doctype html><script src=\"https://cdn.tailwindcss.com\"></script>"), false);
  assert.equal(htmlPreviewFollowsTheme("html", "<!doctype html><link rel=\"stylesheet\" href=\"x.css\">"), false);
  assert.equal(htmlPreviewFollowsTheme("svg", "<svg/>"), false);
});

test("injects theme colours only into documents that follow the theme", () => {
  const plain = buildHtmlPreviewDocument("html", "<!doctype html><html><head></head><body>x</body></html>", { theme });
  assert.match(plain, /:root\{color-scheme:dark;background:rgb\(28, 28, 30\);color:rgb\(245, 245, 247\)\}/);

  const styled = buildHtmlPreviewDocument("html", "<!doctype html><style>body{background:#fff}</style>", { theme });
  assert.doesNotMatch(styled, /color-scheme:dark/);

  const hostile = buildHtmlPreviewDocument("html", "<!doctype html><p>x</p>", { theme: { ...theme, background: "red}</style><script>x()</script>" } });
  assert.doesNotMatch(hostile, /color-scheme/);
});

test("reports errors and routes links only when asked", () => {
  const browser = buildHtmlPreviewDocument("html", "<!doctype html><p>x</p>");
  assert.match(browser, new RegExp(HTML_PREVIEW_ERROR_MESSAGE));
  assert.match(browser, /unhandledrejection/);
  assert.doesNotMatch(browser, new RegExp(HTML_PREVIEW_OPEN_MESSAGE));
  assert.match(browser, /a\.target="_blank"/);

  const desktop = buildHtmlPreviewDocument("html", "<!doctype html><p>x</p>", { routeLinksToParent: true });
  assert.match(desktop, new RegExp(HTML_PREVIEW_OPEN_MESSAGE));
  assert.match(desktop, /window\.open=function/);
});

const component = `import { useState } from "react";
import { Heart } from "lucide-react";
export default function App() {
  const [n, setN] = useState(0);
  return <button className="p-2" onClick={() => setN(n + 1)}><Heart /> {n}</button>;
}`;

test("previews only self-contained React components", () => {
  assert.equal(htmlPreviewKind("jsx", component), "react");
  assert.equal(htmlPreviewKind("TSX", component), "react");
  assert.equal(htmlPreviewKind("js", component), null);
  assert.equal(isRunnableReactComponent("function App() { return <div/>; }"), false, "no default export");
  assert.equal(isRunnableReactComponent(`import Button from "./Button";\nexport default () => <Button/>;`), false);
  assert.equal(isRunnableReactComponent(`import { Card } from "@/components/ui/card";\nexport default () => <Card/>;`), false);
  assert.equal(isRunnableReactComponent("export default function sum(a, b) { return a + b; }"), false, "no JSX");
});

const runtime = {
  react: "globalThis.__piPreviewRuntime={React:{default:{}}};/* </script> inside a comment */",
  sucrase: "globalThis.__piSucrase={transform(){}};",
  tailwind: "/* tailwind */",
  modules: {
    react: { global: "React", exports: ["useState", "createElement", "bad-name"] },
    "react/jsx-runtime": { global: "JsxRuntime", exports: ["jsx", "jsxs", "Fragment"] },
    "react-dom/client": { global: "ReactDomClient", exports: ["createRoot"] },
  },
};
const FACADE_PREFIX = "data:text/javascript;charset=utf-8,";

test("maps React to the inlined runtime and other packages to esm.sh", () => {
  assert.deepEqual(reactImportSpecifiers(`${component}\nimport * as d3 from "d3";\nimport "./x.css";\nconst m = await import("lodash/debounce");`), ["lucide-react", "d3", "lodash/debounce"]);
  const map = reactImportMap(component, runtime);
  assert.ok(map.react.startsWith(FACADE_PREFIX));
  assert.equal(
    decodeURIComponent(map.react.slice(FACADE_PREFIX.length)),
    'const m=globalThis.__piPreviewRuntime["React"];const x=m.default??m;export default x;export const {useState,createElement}=x;',
  );
  assert.equal(map["react/jsx-dev-runtime"], map["react/jsx-runtime"]);
  assert.ok(map["react-dom/client"].startsWith(FACADE_PREFIX));
  assert.equal(map["lucide-react"], "https://esm.sh/lucide-react?external=react,react-dom");
  assert.deepEqual(reactImportSpecifiers(`import x from "https://evil.example/x.js"; import y from "a b";`), []);
});

test("inlines the runtime so neither it nor the source can close a script element", () => {
  const doc = buildHtmlPreviewDocument("react", `export default () => <p>{"</script><script>alert(1)</script>"}</p>;`, { runtime });
  assert.equal(doc.match(/<\/script>/g).length, doc.match(/<script\b/g).length);
  assert.match(doc, /<script type="importmap">/);
  assert.ok(doc.includes("/* <\\/script> inside a comment */"));
  assert.match(doc, /globalThis\.__piSucrase\.transform\(source/);
  assert.match(doc, /window\.__piPreviewError=err/);
  assert.doesNotMatch(doc, /color-scheme|cdn\.tailwindcss\.com|preview-runtime\//);
});

test("reports a missing runtime instead of rendering nothing", () => {
  assert.match(buildHtmlPreviewDocument("react", "export default () => <p/>;"), /The React preview runtime is not loaded/);
});

test("shows an escaped loading label until the component renders", () => {
  const doc = buildHtmlPreviewDocument("react", "export default () => <p/>;", { loadingLabel: "<b>Loading</b>", runtime });
  assert.match(doc, /&#60;b&#62;Loading&#60;\/b&#62;/);
});

test("detects documents that run code", () => {
  assert.equal(htmlPreviewHasActiveContent("<!doctype html><p>static</p><style>p{}</style>"), false);
  assert.equal(htmlPreviewHasActiveContent("<!doctype html><script>x()</script>"), true);
  assert.equal(htmlPreviewHasActiveContent("<!doctype html><img src=x onerror=\"x()\">"), true);
  assert.equal(htmlPreviewHasActiveContent("<!doctype html><a href=\"javascript:x()\">a</a>"), true);
  assert.equal(htmlPreviewHasActiveContent("<svg><circle r=\"4\"/></svg>"), false);
});

test("falls back to a data: URL when the blob module import is refused", () => {
  const doc = buildHtmlPreviewDocument("react", "export default () => <p/>;", { runtime });
  assert.match(doc, /import\("data:text\/javascript;charset=utf-8,"\+encodeURIComponent\(compiled\)\)/);
});

test("moves the page's inline classic scripts into data: URLs so WebKit keeps error details", async () => {
  const { externalizeInlineScripts } = await import("./html-preview.ts");
  const decode = (html) => decodeURIComponent(/src="data:text\/javascript;charset=utf-8,([^"]*)"/.exec(html)[1]);

  const plain = externalizeInlineScripts('<script>const a = "<b>&</b>";\nrun(a)</script>');
  assert.match(plain, /^<script src="data:text\/javascript;charset=utf-8,[^"]*"><\/script>$/);
  assert.equal(decode(plain), 'const a = "<b>&</b>";\nrun(a)');

  const deferred = externalizeInlineScripts('<script defer id="main" async="">go()</script>');
  assert.match(deferred, /^<script id="main" src="data:/);
  assert.doesNotMatch(deferred, /\b(?:defer|async)\b/);

  for (const untouched of [
    '<script src="https://cdn.example/x.js"></script>',
    '<script type="module">import x from "y"</script>',
    '<script type="text/babel">const A = () => <p/></script>',
    '<script type="application/json">{"a":1}</script>',
    '<script type="importmap">{"imports":{}}</script>',
    "<script>   </script>",
  ]) {
    assert.equal(externalizeInlineScripts(untouched), untouched);
  }
  assert.match(externalizeInlineScripts('<SCRIPT type="text/javascript">x()</SCRIPT>'), /src="data:/);
});

test("the built document runs author scripts from data: URLs but keeps the bootstrap inline", () => {
  const doc = buildHtmlPreviewDocument("html", "<!DOCTYPE html><html><head></head><body><script>missing()</script></body></html>");
  assert.match(doc, /<head><script>\(function\(\)\{/);
  assert.match(doc, /<body><script src="data:text\/javascript;charset=utf-8,missing\(\)"><\/script><\/body>/);
  assert.match(doc, /the browser hid the details/);
});

test("names the packages when an esm.sh import fails", () => {
  const doc = buildHtmlPreviewDocument("react", component, { runtime });
  assert.match(doc, /const packages=\["lucide-react"\];/);
  assert.match(doc, /F\(M\.packagesNeedNetwork,\{packages:packages\.join\(", "\),error:m\}\)/);
  assert.match(doc, /"packagesNeedNetwork":"Could not load \{packages\} from esm\.sh/);
});

test("the frame reports errors in the wording it is given", () => {
  const doc = buildHtmlPreviewDocument("html", "<!DOCTYPE html><html><body>x</body></html>", {
    messages: { failedToLoad: "无法加载 {resource}", unhandledRejection: "未处理的 Promise 拒绝：{reason}" },
  });
  assert.match(doc, /"failedToLoad":"无法加载 \{resource\}"/);
  assert.match(doc, /"unhandledRejection":"未处理的 Promise 拒绝：\{reason\}"/);
  // Untranslated keys keep the English default.
  assert.match(doc, /"noDefaultExport":"The component has no default export\."/);
  // Placeholders are filled inside the frame, so run the formatter it defines.
  const line = doc.split("\n").find((text) => text.startsWith("var F=window.__piPreviewFormat="));
  const format = new Function(`return ${line.slice("var F=window.__piPreviewFormat=".length).replace(/;$/, "")}`)();
  assert.equal(format("无法加载 {resource}", { resource: "script https://x/y.js" }), "无法加载 script https://x/y.js");
  assert.equal(format("{missing} stays", {}), "{missing} stays");
});

const kitSvg = '<svg viewBox="0 0 100 40"><g class="c-blue"><rect class="box" width="40" height="20"/><text class="t">A</text></g></svg>';
const kitHtml = '<!doctype html><html><head><title>t</title></head><body><style>.card{color:var(--color-text-primary);background:var(--color-background-secondary)}</style><div class="card">x</div></body></html>';
const kitTheme = { scheme: "dark", background: "rgb(28, 28, 30)", text: "rgb(245, 245, 247)" };

test("a page that uses the theme kit follows the theme whatever else it declares", () => {
  assert.equal(htmlPreviewFollowsTheme("html", kitHtml), true);
  assert.equal(htmlPreviewFollowsTheme("svg", kitSvg), true);
  assert.equal(htmlPreviewFollowsTheme("svg", "<svg><circle/></svg>"), false);
  assert.equal(htmlPreviewFollowsTheme("react", "export default () => <div style={{color:'var(--color-text-primary)'}} />"), false);
});

test("injects the kit into pages that use it and into no others", () => {
  const doc = buildHtmlPreviewDocument("html", kitHtml, { theme: kitTheme });
  assert.equal(doc.match(/<style id="pi-theme-kit"/g).length, 1);
  assert.match(doc, /<style id="pi-theme-canvas"/);
  // Before the bootstrap and the page's own styles, so the page can override it.
  assert.ok(doc.indexOf('<style id="pi-theme-kit"') < doc.indexOf("pi-html-preview:size"));
  assert.ok(doc.indexOf('<style id="pi-theme-kit"') < doc.indexOf(".card{"));
  const other = buildHtmlPreviewDocument("html", "<!doctype html><h1>Plain</h1>", { theme: kitTheme });
  assert.doesNotMatch(other, /<style id="pi-theme-kit"/);
  assert.match(other, /<style id="pi-theme-canvas"/);
});

test("uses the theme kit it is given, else the scheme's defaults", () => {
  const given = buildHtmlPreviewDocument("html", kitHtml, { theme: kitTheme, themeKit: { scheme: "dark", vars: { "--color-text-primary": "#abcdef" } } });
  assert.match(given, /--color-text-primary:#abcdef/);
  const dark = buildHtmlPreviewDocument("html", kitHtml, { theme: kitTheme });
  assert.match(dark, /color-scheme:dark;--color-text-primary:#f5f5f7/);
  const bare = buildHtmlPreviewDocument("html", kitHtml);
  assert.match(bare, /color-scheme:light;--color-text-primary:#1d1d1f/);
});

test("an SVG that uses the kit sits on the app canvas, not on white", () => {
  const themed = buildHtmlPreviewDocument("svg", kitSvg, { theme: kitTheme });
  assert.doesNotMatch(themed, /background:#fff/);
  assert.match(themed, /<style id="pi-theme-canvas"/);
  assert.match(themed, /<style id="pi-theme-kit"/);
  assert.match(themed, /<body><svg viewBox="0 0 100 40">/);
  const plain = buildHtmlPreviewDocument("svg", "<svg><circle r=\"4\"/></svg>", { theme: kitTheme });
  assert.match(plain, /background:#fff/);
  assert.doesNotMatch(plain, /<style id="pi-theme-/);
});

test("the frame answers theme messages from its parent only, and only for what the page follows", () => {
  const doc = buildHtmlPreviewDocument("html", kitHtml, { theme: kitTheme });
  assert.match(doc, new RegExp(HTML_PREVIEW_READY_MESSAGE));
  assert.match(doc, new RegExp(HTML_PREVIEW_THEME_MESSAGE));
  assert.match(doc, /e\.source!==parent/);
  assert.match(doc, /getElementById\("pi-theme-canvas"\)/);
  assert.match(doc, /getElementById\("pi-theme-kit"\)/);
});

test("downloads write the kit's light values into the file, and leave other pages as written", () => {
  const svg = htmlPreviewDownloadSource("svg", kitSvg);
  assert.match(svg, /^<svg viewBox="0 0 100 40"><style id="pi-theme-kit">:root\{color-scheme:light;/);
  const html = htmlPreviewDownloadSource("html", kitHtml);
  assert.match(html, /<head><style id="pi-theme-kit">/);
  assert.doesNotMatch(html, /pi-html-preview/);
  const fragment = htmlPreviewDownloadSource("html", '<div style="color:var(--color-text-primary)">x</div>');
  assert.ok(fragment.startsWith('<style id="pi-theme-kit">'));
  const plain = "<!doctype html><h1>Plain</h1>";
  assert.equal(htmlPreviewDownloadSource("html", plain), plain);
  assert.equal(htmlPreviewDownloadSource("react", "export default () => <p style={{color:'var(--color-text-primary)'}}/>"), "export default () => <p style={{color:'var(--color-text-primary)'}}/>");
});

test("pages get sendPrompt, which needs a user action and a bounded string", () => {
  const doc = buildHtmlPreviewDocument("html", "<!doctype html><button onclick=\"sendPrompt('hi')\">go</button>");
  assert.match(doc, /window\.sendPrompt=function/);
  assert.match(doc, new RegExp(HTML_PREVIEW_PROMPT_MESSAGE));
  assert.match(doc, /navigator\.userActivation&&!navigator\.userActivation\.isActive/);
  assert.match(doc, new RegExp(`slice\\(0,${HTML_PREVIEW_MAX_PROMPT_LENGTH}\\)`));
  // The bootstrap defines it before any of the page's own scripts can call it.
  const svg = buildHtmlPreviewDocument("svg", "<svg/>");
  assert.match(svg, /window\.sendPrompt=function/);
});

test("accepts only non-empty strings as prompts, trimmed and cut", () => {
  assert.equal(framePromptText("  Break down step 2 \n"), "Break down step 2");
  assert.equal(framePromptText(""), null);
  assert.equal(framePromptText("   "), null);
  assert.equal(framePromptText(42), null);
  assert.equal(framePromptText({ toString: () => "x" }), null);
  assert.equal(framePromptText(undefined), null);
  assert.equal(framePromptText("a".repeat(HTML_PREVIEW_MAX_PROMPT_LENGTH + 500)).length, HTML_PREVIEW_MAX_PROMPT_LENGTH);
});
