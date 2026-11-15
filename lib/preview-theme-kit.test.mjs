import assert from "node:assert/strict";
import test from "node:test";
import {
  buildThemeKit,
  defaultThemeKit,
  isPreviewColor,
  safeThemeKitVars,
  themeKitStyle,
  themeKitSvgSource,
  usesThemeKit,
} from "./preview-theme-kit.ts";

test("only pages that ask for the kit get it", () => {
  assert.equal(usesThemeKit('<p style="color:var(--color-text-primary)">x</p>'), true);
  assert.equal(usesThemeKit("<style>.a{fill:var( --color-series-1 )}</style>"), true);
  assert.equal(usesThemeKit('<svg><g class="c-blue"><rect/></g></svg>'), true);
  assert.equal(usesThemeKit('<svg><path class="arr" d="M0 0"/></svg>'), true);
  // Names that are common on their own do not count.
  assert.equal(usesThemeKit('<div class="box">x</div>'), false);
  assert.equal(usesThemeKit('<div class="arr">x</div>'), false);
  assert.equal(usesThemeKit('<svg><rect class="box"/></svg>'), false);
  assert.equal(usesThemeKit("<h1>Plain</h1>"), false);
  assert.equal(usesThemeKit("<p>var(--color-x)</p>"), false);
});

test("builds the base variables from the app tokens, with defaults for what is missing or unsafe", () => {
  const kit = buildThemeKit("dark", {
    background: "rgb(28, 28, 30)",
    text: "rgb(245, 245, 247)",
    border: "red;} body{display:none",
    danger: undefined,
  });
  assert.equal(kit.scheme, "dark");
  assert.equal(kit.vars["--color-background-primary"], "rgb(28, 28, 30)");
  assert.equal(kit.vars["--color-text-primary"], "rgb(245, 245, 247)");
  assert.equal(kit.vars["--color-border-tertiary"], defaultThemeKit("dark").vars["--color-border-tertiary"]);
  assert.equal(kit.vars["--color-text-danger"], defaultThemeKit("dark").vars["--color-text-danger"]);
  for (let n = 1; n <= 6; n++) assert.ok(kit.vars[`--color-series-${n}`], `series ${n}`);
  assert.notEqual(defaultThemeKit("light").vars["--color-series-1"], defaultThemeKit("dark").vars["--color-series-1"]);
});

test("accepts computed colours and nothing that can leave a declaration", () => {
  for (const ok of ["#fff", "rgb(0, 0, 0)", "rgba(0, 0, 0, 0.12)", "color(srgb 0.1 0.2 0.3 / 0.5)", "hsl(120 50% 40%)"]) {
    assert.equal(isPreviewColor(ok), true, ok);
  }
  for (const bad of ["red;}", "url(x)", "</style>", 'a"b', "x{y", 5, undefined, "a".repeat(200)]) {
    assert.equal(isPreviewColor(bad), false, String(bad));
  }
  assert.deepEqual(safeThemeKitVars({ "--color-text-primary": "#000", "--color-text-x": "red;}", "--evil": "#fff", "color": "#fff" }), { "--color-text-primary": "#000" });
});

test("the style defines the variables, derives the rest and keeps every class rule specificity-free", () => {
  const style = themeKitStyle(defaultThemeKit("light"));
  assert.match(style, /^<style id="pi-theme-kit">:root\{color-scheme:light;/);
  assert.match(style, /--color-text-primary:#1d1d1f/);
  assert.match(style, /--color-background-secondary:color-mix\(/);
  assert.match(style, /--color-border-secondary:color-mix\(/);
  assert.match(style, /--color-background-danger:color-mix\(/);
  assert.match(style, /--font-sans:/);
  assert.match(style, /:where\(svg marker path\)\{fill:var\(--color-text-tertiary\)\}/);
  for (const name of ["t", "ts", "th", "box", "arr", "leader", "c-blue", "c-teal", "c-amber", "c-red", "c-purple", "c-gray"]) {
    assert.match(style, new RegExp(`:where\\(svg \\.${name}\\b`), name);
  }
  // Any rule outside :root must be inside :where(): a page's own CSS has to win.
  const rules = style.replace(/^<style[^>]*>/, "").replace(/<\/style>$/, "").replace(/^:root\{[^}]*\}/, "");
  for (const rule of rules.split("}").filter(Boolean)) assert.match(rule, /^:where\(/, rule);
  assert.doesNotMatch(style, /<\/style>.+/s);
});

test("a hostile value never reaches the style", () => {
  const style = themeKitStyle({ scheme: "light", vars: { "--color-text-primary": "red}</style><script>x()</script>", "--color-text-info": "#123" } });
  assert.doesNotMatch(style, /<script/);
  assert.match(style, /--color-text-info:#123/);
});

test("puts the kit inside an SVG that uses it, and leaves other SVG alone", () => {
  const kit = defaultThemeKit("light");
  const used = '<svg viewBox="0 0 10 10"><g class="c-blue"><rect width="4" height="4"/></g></svg>';
  const out = themeKitSvgSource(used, kit);
  assert.match(out, /^<svg viewBox="0 0 10 10"><style id="pi-theme-kit">/);
  assert.ok(out.endsWith('<g class="c-blue"><rect width="4" height="4"/></g></svg>'));

  const plain = '<svg viewBox="0 0 10 10"><rect/></svg>';
  assert.equal(themeKitSvgSource(plain, kit), plain);
  const selfClosing = '<svg class="c-blue"/>';
  assert.equal(themeKitSvgSource(selfClosing, kit), selfClosing);
});
