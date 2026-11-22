import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Chart } from "diagrammatic/spec";
import { CHART_TYPES, padWideText, parseChartSpec } from "./chart-spec.ts";

const parse = (spec) => parseChartSpec(typeof spec === "string" ? spec : JSON.stringify(spec));
const draw = (spec) => {
  const result = parse(spec);
  assert.equal(result.ok, true, result.error);
  return renderToStaticMarkup(createElement(Chart, { spec: result.spec }));
};

// One spec per supported type, written the way the prompt describes them.
const SAMPLES = {
  bar: { type: "bar", title: "Latency", items: [{ label: "A", value: 3 }, { label: "B", value: 5 }] },
  column: { type: "column", items: [{ label: "Mon", value: 3 }, { label: "Tue", value: 5 }] },
  line: { type: "line", labels: ["W1", "W2", "W3"], series: [{ name: "in", data: [1, 4, 2] }, { name: "out", data: [2, 1, 3] }], unit: "compact" },
  area: { type: "area", labels: ["a", "b", "c"], data: [1, 3, 2] },
  "stacked-bar": { type: "stacked-bar", groups: ["s1", "s2"], series: [{ name: "read", data: [3, 4] }, { name: "edit", data: [1, 2] }] },
  "grouped-bar": { type: "grouped-bar", groups: ["Q1", "Q2"], series: [{ name: "2025", data: [3, 4] }, { name: "2026", data: [5, 2] }] },
  pie: { type: "pie", items: [{ label: "Opus", value: 62 }, { label: "Sonnet", value: 38 }], inner: 0.5 },
  scatter: { type: "scatter", points: [{ x: 1, y: 2 }, { x: 3, y: 5, label: "outlier" }], xLabel: "tokens", yLabel: "ms" },
  heatmap: { type: "heatmap", matrix: { rows: ["Mon", "Tue"], cols: ["9h", "10h", "11h"], values: [[1, 2, 3], [3, 2, 1]] } },
  waterfall: { type: "waterfall", steps: [{ label: "Start", value: 10 }, { label: "Cost", value: -3 }, { label: "End", value: 7, total: true }] },
  funnel: { type: "funnel", items: [{ label: "Visit", value: 100 }, { label: "Sign up", value: 30 }] },
};

test("every supported type parses and draws as SVG", () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...CHART_TYPES].sort());
  for (const [type, spec] of Object.entries(SAMPLES)) {
    const svg = draw(spec);
    assert.match(svg, /^<svg\b/, type);
    assert.doesNotMatch(svg, /Unknown chart type/, type);
  }
});

test("only known fields reach the library: svg props from the spec are dropped", () => {
  const result = parse({
    ...SAMPLES.bar,
    style: { background: "url(https://evil.example/pixel.png)" },
    href: "javascript:alert(1)",
    xlinkHref: "https://evil.example",
    onLoad: "alert(1)",
    className: "x",
    dangerouslySetInnerHTML: { __html: "<foreignObject>PWN</foreignObject>" },
    items: [{ label: "A", value: 3, style: { fill: "url(https://evil.example/f)" }, href: "https://evil.example" }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.spec).sort(), ["items", "title", "type"]);
  assert.deepEqual(result.spec.items, [{ label: "A", value: 3 }]);
  const svg = renderToStaticMarkup(createElement(Chart, { spec: result.spec }));
  assert.doesNotMatch(svg, /evil|javascript:|PWN|onload/i);
});

test("text is escaped by React, not interpreted", () => {
  const svg = draw({ type: "bar", title: "<script>alert(1)</script>", items: [{ label: "<img src=x onerror=alert(1)>", value: 1 }] });
  assert.doesNotMatch(svg, /<script|<img/);
});

test("bad specs fail with the field that is wrong, before drawing", () => {
  const cases = [
    ["{not json", /^Not valid JSON/],
    [[1, 2], /^spec: must be a JSON object/],
    [{ type: "radar" }, /^type: must be one of bar, column/],
    [{ type: "bar" }, /^items: is required/],
    [{ type: "bar", items: [] }, /^items: must not be empty/],
    [{ type: "bar", items: [{ label: "a", value: "3" }] }, /^items\[0\]\.value: must be a finite number/],
    [{ type: "bar", items: [{ label: "a", value: null }] }, /^items\[0\]\.value: is required/],
    [{ type: "bar", items: [3] }, /^items\[0\]: must be an object/],
    [{ type: "line", labels: ["a", "b"], series: [{ name: "s", data: [1] }] }, /^series\[0\]\.data: has 1 values but there are 2 labels/],
    [{ type: "line", labels: ["a"] }, /^series: is required/],
    [{ type: "line", series: [{ name: "s" }] }, /^series\[0\]\.data: is required/],
    [{ type: "heatmap", matrix: { rows: ["r"], cols: ["a", "b"], values: [[1]] } }, /^matrix\.values\[0\]: has 1 values but there are 2 cols/],
    [{ type: "pie", items: [{ label: "a", value: 1 }], inner: 2 }, /^inner: must be between 0 and 0\.9/],
    [{ type: "bar", unit: "usd", items: [{ label: "a", value: 1 }] }, /^unit: must be one of percent, compact, none/],
    [{ type: "scatter", points: Array.from({ length: 5001 }, (_, i) => ({ x: i, y: i })) }, /^points: has 5001 entries; at most 5000/],
  ];
  for (const [spec, error] of cases) {
    const result = parse(spec);
    assert.equal(result.ok, false, JSON.stringify(spec).slice(0, 80));
    assert.match(result.error, error);
  }
});

test("charts get a value axis by default, and numbers in label slots become text", () => {
  assert.equal(parse(SAMPLES.line).spec.yTicks, 5);
  assert.equal(parse(SAMPLES.column).spec.yTicks, 5);
  assert.deepEqual(parse({ type: "line", labels: [2024, 2025], data: [1, 2] }).spec.labels, ["2024", "2025"]);
});

test("wide characters are padded so the library's width estimate holds", () => {
  assert.equal(padWideText("Claude"), "Claude");
  assert.equal(padWideText("模型"), "模​型​");
  assert.equal(padWideText("A 模型 1"), "A 模​型​ 1");
  // A long CJK bar label gets a gutter wide enough to start inside the chart.
  const svg = draw({ type: "bar", items: [{ label: "某个名字很长很长的本地模型", value: 5 }, { label: "b", value: 3 }] });
  const x = Number(/<text x="([\d.]+)"[^>]*text-anchor="end"[^>]*>某个名字很长很长的本地模型/.exec(svg.replace(/\u200b/g, ""))?.[1]);
  // 13 glyphs at about 1 em (12.1px at the 1.1em label size) need roughly 157px.
  assert.ok(x >= 150, `label gutter ${x}px`);
});

test("the title is kept for the caption and stays the chart's accessible name", () => {
  const result = parse(SAMPLES.bar);
  assert.equal(result.title, "Latency");
  assert.match(draw(SAMPLES.bar), /aria-label="Latency"/);
});

test("a shortened wide label still fits: its padding is cut with it", () => {
  // At phone width the library cuts long labels; it must not cut only padding.
  const svg = renderToStaticMarkup(createElement(Chart, { spec: { ...parse({ type: "bar", items: [{ label: "某个名字很长很长的本地模型", value: 5 }, { label: "b", value: 3 }] }).spec, width: 300 } }));
  const match = /<text x="([\d.]+)"[^>]*text-anchor="end"[^>]*>([^<]*…)<\/text>/.exec(svg);
  assert.ok(match, "the label was shortened");
  const glyphs = match[2].replace(/​/g, "").length;
  // Wide glyphs draw about 1.1 em at 11 px; the gutter must hold what is drawn.
  assert.ok(Number(match[1]) >= (glyphs - 1) * 12, `x=${match[1]} for ${glyphs} glyphs`);
});

test("axis titles go to the caption: the library draws them over the middle tick", () => {
  const result = parse({ type: "scatter", xLabel: "参数量（B）", yLabel: "Latency", points: [{ x: 1, y: 2 }, { x: 40, y: 400 }] });
  assert.deepEqual(result.axes, { x: "参数量（B）", y: "Latency" });
  assert.equal("xLabel" in result.spec, false);
  assert.equal("yLabel" in result.spec, false);
  assert.deepEqual(parse(SAMPLES.bar).axes, { x: null, y: null });
  assert.match(parse({ type: "scatter", xLabel: 3, points: [{ x: 1, y: 2 }] }).spec.type, /scatter/);
  assert.match(parse({ type: "scatter", xLabel: {}, points: [{ x: 1, y: 2 }] }).error, /^xLabel: must be a string/);
});

test("the module's source is ASCII outside comments and strings shown to people", async () => {
  // Bundles are served without a charset in the e2e harness; a literal CJK
  // range in a regex then decodes as Latin-1 and throws when the module loads.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./chart-spec.ts", import.meta.url), "utf8");
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  assert.deepEqual(code.filter((line) => /[^\x00-\x7f]/.test(line)), []);
});
