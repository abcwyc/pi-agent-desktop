import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseChartSpec } = await jiti.import("./chart-spec.ts");
const { describeChartMark, formatTooltipValue } = await jiti.import("./chart-tooltip.ts");

const spec = (value) => {
  const result = parseChartSpec(JSON.stringify(value));
  assert.equal(result.ok, true, result.error);
  return result.spec;
};
const say = (value, mark) => describeChartMark(spec(value), mark, "en-US");

test("single-value forms name the item and its exact value", () => {
  assert.deepEqual(say({ type: "bar", items: [{ label: "A", value: 12000 }, { label: "B", value: 5 }] }, { index: 0 }), { title: "A", rows: [{ label: "", value: "12,000" }] });
  assert.equal(say({ type: "column", items: [{ label: "Mon", value: 3.25 }] }, { index: 0 }).rows[0].value, "3.25");
  assert.equal(say({ type: "funnel", items: [{ label: "Visit", value: 100 }] }, { index: 0 }).title, "Visit");
  assert.equal(say({ type: "waterfall", steps: [{ label: "Start", value: 10 }, { label: "Cost", value: -3 }] }, { index: 1 }).rows[0].value, "-3");
  // A pie also says its share.
  assert.equal(say({ type: "pie", items: [{ label: "Opus", value: 62 }, { label: "Sonnet", value: 38 }] }, { index: 0 }).rows[0].value, "62 · 62%");
});

test("lines and bars by group list every series at that point, the hovered one marked", () => {
  const line = say({ type: "line", labels: ["W1", "W2"], series: [{ name: "in", data: [12000, 18000] }, { name: "out", data: [4000, 6000] }], unit: "compact" }, { index: 1, series: "out" });
  assert.deepEqual(line, { title: "W2", rows: [
    { label: "in", value: "18,000", series: "in", active: false },
    { label: "out", value: "6,000", series: "out", active: true },
  ] });
  assert.deepEqual(say({ type: "area", labels: ["a", "b"], data: [1, 3] }, { index: 1 }), { title: "b", rows: [{ label: "", value: "3" }] });
  // The whole line (no index) names no value.
  assert.equal(say({ type: "line", labels: ["a"], data: [1] }, { series: "" }), null);
  const stacked = say({ type: "stacked-bar", groups: ["s1", "s2"], series: [{ name: "read", data: [3, 4] }, { name: "edit", data: [1, 2] }] }, { index: 1 });
  assert.deepEqual(stacked.rows.map((row) => [row.label, row.value]), [["read", "4"], ["edit", "2"], ["Σ", "6"]]);
  const grouped = say({ type: "grouped-bar", groups: ["Q1"], series: [{ name: "x", data: [3] }, { name: "y", data: [5] }] }, { index: 0, series: "y" });
  assert.equal(grouped.rows.length, 2, "grouped bars have no total");
  assert.equal(grouped.rows[1].active, true);
});

test("scatter and heatmap name both coordinates", () => {
  assert.deepEqual(say({ type: "scatter", points: [{ x: 1, y: 2 }, { x: 34, y: 205, label: "ultra-34B" }] }, { index: 1 }), {
    title: "ultra-34B", rows: [{ label: "x", value: "34" }, { label: "y", value: "205" }],
  });
  // `i` is the column, `i2` the row.
  assert.deepEqual(say({ type: "heatmap", matrix: { rows: ["Mon", "Tue"], cols: ["9h", "10h", "11h"], values: [[1, 2, 3], [4, 5, 6]] } }, { index: 2, index2: 1 }), {
    title: "Tue · 11h", rows: [{ label: "", value: "6" }],
  });
});

test("labels come back without the layout padding, and bad addresses say nothing", () => {
  const padded = say({ type: "bar", items: [{ label: "某个模型", value: 1 }] }, { index: 0 });
  assert.equal(padded.title, "某个模型");
  assert.equal(say({ type: "bar", items: [{ label: "A", value: 1 }] }, { index: 5 }), null);
  assert.equal(say({ type: "bar", items: [{ label: "A", value: 1 }] }, {}), null);
  assert.equal(say({ type: "heatmap", matrix: { rows: ["r"], cols: ["c"], values: [[1]] } }, { index: 0, index2: 3 }), null);
});

test("percent values keep the axis's sign", () => {
  assert.equal(formatTooltipValue(12.345, "percent", "en-US"), "12.345%");
  assert.equal(formatTooltipValue(1234567, "compact", "en-US"), "1,234,567");
});
