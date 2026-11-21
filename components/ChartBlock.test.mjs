import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChartBlock, rowChartHeight } = await jiti.import("./ChartBlock.tsx");
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (element) => renderToStaticMarkup(React.createElement(I18nProvider, null, element));
const spec = JSON.stringify({ type: "bar", title: "Latency", items: [{ label: "A", value: 3 }] });

test("a streaming chart shows its source: the JSON is not complete yet", () => {
  const html = render(React.createElement(ChartBlock, { code: spec.slice(0, 20), isStreaming: true }));
  assert.match(html, /markdown-code-block/);
  assert.doesNotMatch(html, /chart-block-body/);
});

test("a finished valid chart waits for the library, then draws in the page", () => {
  const html = render(React.createElement(ChartBlock, { code: spec }));
  assert.match(html, /chart-block-loading/);
  assert.doesNotMatch(html, /<iframe/);
});

test("an invalid spec shows the field error; Ask to fix only where a reply wrote it", () => {
  const bad = JSON.stringify({ type: "bar", items: [{ label: "A", value: "3" }] });
  const html = render(React.createElement(ChartBlock, { code: bad }));
  assert.match(html, /chart-block-error/);
  assert.match(html, /items\[0\]\.value: must be a finite number/);
  assert.doesNotMatch(html, /mermaid-fix/);
});

test("MarkdownBody hands ```chart fences to ChartBlock", () => {
  const html = render(React.createElement(MarkdownBody, { artifacts: true }, "```chart\n{\"type\":\"pie\"}\n```"));
  assert.match(html, /chart-block-error/);
  assert.match(html, /items: is required/);
});

test("bar and funnel charts take their height from their rows", () => {
  const items = (n) => Array.from({ length: n }, (_, i) => ({ label: String(i), value: i + 1 }));
  assert.equal(rowChartHeight({ type: "bar", items: items(5) }, 684), 240);
  assert.equal(rowChartHeight({ type: "bar", items: items(1) }, 684), 120);
  // Never taller than the library's own proportions would make a wide chart.
  assert.equal(rowChartHeight({ type: "funnel", items: items(40) }, 400), 300);
  assert.equal(rowChartHeight({ type: "line", labels: [] }, 684), undefined);
  assert.equal(rowChartHeight({ type: "pie", items: items(3) }, 684), 300);
  assert.equal(rowChartHeight({ type: "pie", items: items(3) }, 300), 220);
});
