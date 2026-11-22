"use client";

import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { downloadUrlAsFile } from "@/lib/desktop-native";
import { parseChartSpec, type CleanChartSpec } from "@/lib/chart-spec";
import { describeChartMark } from "@/lib/chart-tooltip";
import { CodeBlock, DiagramFixButton } from "./MermaidBlock";

type MarkDatum = { index: number | undefined; index2: number | undefined; series: string | undefined; element: Element };
interface ChartKit {
  Chart: ComponentType<{ spec: CleanChartSpec; className?: string }>;
  /** Delegates pointer events to the marks; feeds the Tooltip and the hover highlight. */
  Root: ComponentType<{ className?: string; highlightOnHover?: boolean | "index" | "series"; children: ReactNode }>;
  Tooltip: ComponentType<{ side?: "top" | "bottom" | "left" | "right"; sideOffset?: number; className?: string; children: (props: { datum: MarkDatum }) => ReactNode }>;
  getSeriesColor: (from: Element, series: string) => string | undefined;
}

// diagrammatic's spec entry holds all of its chart forms (about 36 KB gzipped,
// its own chunk) and its interactive entry the hover layer, so both load on
// the first chart, once per page. A fence that is still streaming starts the
// load, so the finished message (a component of its own) can draw on its
// first render instead of flashing a placeholder.
let chartModule: Promise<ChartKit> | null = null;
let loadedChart: ChartKit | null = null;
function loadChart(): Promise<ChartKit> {
  chartModule ??= Promise.all([import("diagrammatic/spec"), import("diagrammatic/interactive")]).then(([spec, interactive]) => {
    loadedChart = {
      Chart: spec.Chart as unknown as ChartKit["Chart"],
      Root: interactive.Root as unknown as ChartKit["Root"],
      Tooltip: interactive.Tooltip as unknown as ChartKit["Tooltip"],
      getSeriesColor: interactive.getSeriesColor,
    };
    return loadedChart;
  });
  // A failed load is not cached: Retry imports again.
  chartModule.catch(() => { chartModule = null; });
  return chartModule;
}

// Charts are drawn at the width they get, so text keeps its size: the library
// scales a wider figure down as a whole, which left 6px labels on a phone.
// Above the cap a chart would only grow taller (its height follows an aspect).
const CHART_MIN_WIDTH = 260;
const CHART_MAX_WIDTH = 760;
const chartWidth = (available: number) => Math.round(Math.min(CHART_MAX_WIDTH, Math.max(CHART_MIN_WIDTH, available)) / 4) * 4;

/**
 * The library's height follows the width, which suits time series but not
 * every form at message width: five horizontal bars stood 410px tall with
 * wide gaps, and a pie 370px. Bars and funnels take their height from their
 * rows, a pie is capped; other forms keep the library's own aspect.
 */
export function rowChartHeight(spec: CleanChartSpec, width: number): number | undefined {
  if (spec.type === "pie") return Math.round(Math.min(300, Math.max(220, width * 0.55)));
  if (spec.type !== "bar" && spec.type !== "funnel") return undefined;
  const rows = Array.isArray(spec.items) ? spec.items.length : 0;
  return Math.round(Math.min(width * 0.75, Math.max(120, 40 + rows * 40)));
}

/** The chart's SVG as a file that stands on its own: colours resolved, layout padding removed. */
export function chartSvgFile(svg: SVGSVGElement, host: Element): string {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const style = getComputedStyle(host);
  const vars = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "pos", "neg"]
    .map((name) => [`--dg-${name}`, style.getPropertyValue(`--dg-${name}`).trim()] as const)
    .filter(([, value]) => value);
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.style.color = style.color;
  copy.style.fontFamily = style.fontFamily;
  copy.style.setProperty("--dg-ink", style.color);
  for (const [name, value] of vars) copy.style.setProperty(name, value);
  // The zero-width spaces lib/chart-spec.ts adds for layout are no text to keep.
  for (const text of copy.querySelectorAll("text, tspan, title")) {
    for (const node of text.childNodes) if (node.nodeType === 3) node.textContent = (node.textContent ?? "").replace(/\u200b/g, "");
  }
  return new XMLSerializer().serializeToString(copy);
}

/**
 * Catches a chart that throws while drawing. lib/chart-spec.ts checks every
 * field it passes, so this is the backstop for shapes it does not know about.
 */
class ChartBoundary extends Component<{ onError: (message: string) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error?.message || String(error));
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// Forms whose marks are items fade the rest while one is hovered. Lines and
// areas do not: their drawn path carries no index, so the whole line faded
// under the pointer; a heatmap would fade everything but one column.
const HIGHLIGHT_ON_HOVER = new Set(["bar", "column", "pie", "funnel", "waterfall", "stacked-bar", "grouped-bar", "scatter"]);

/**
 * The hover card: the mark's category and its exact values (lib/chart-tooltip.ts),
 * one row per series with that series' own colour when there are several.
 * Nothing for an address that names no value (a whole line, a frame).
 */
function ChartTooltipCard({ spec, datum, locale, getSeriesColor }: {
  spec: CleanChartSpec;
  datum: MarkDatum;
  locale: string;
  getSeriesColor: ChartKit["getSeriesColor"];
}) {
  const content = describeChartMark(spec, { index: datum.index, index2: datum.index2, series: datum.series }, locale);
  if (!content) return null;
  return (
    <div className="chart-tooltip" role="status">
      <div className="chart-tooltip-title">{content.title}</div>
      {content.rows.map((row, index) => (
        <div key={index} className={`chart-tooltip-row${row.active ? " is-active" : ""}`}>
          {row.series !== undefined && (
            <span className="chart-tooltip-swatch" style={{ background: getSeriesColor(datum.element, row.series) ?? "currentColor" }} aria-hidden="true" />
          )}
          {row.label && <span className="chart-tooltip-label">{row.label}</span>}
          <span className="chart-tooltip-value">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

interface ChartBlockProps {
  code: string;
  isStreaming?: boolean;
  /** Offer "Ask to fix" (assistant text only), like MermaidBlock's `fixable`. */
  fixable?: boolean;
}

/**
 * A ```chart fence: a JSON spec drawn as plain SVG in the page by
 * diagrammatic. No frame and no script: the spec is data, rebuilt from an
 * allowlist before it reaches the library. Source while streaming (the JSON
 * is incomplete), then the chart, with a Source toggle and SVG download.
 */
export function ChartBlock({ code, isStreaming, fixable }: ChartBlockProps) {
  const { t, locale } = useI18n();
  const [showChart, setShowChart] = useState(true);
  const [Chart, setChart] = useState<ChartKit | null>(() => loadedChart);
  // The library could not be loaded: Retry, never "Ask to fix" (the spec may be fine).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [drawError, setDrawError] = useState<{ code: string; message: string } | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const figureRef = useRef<HTMLElement>(null);
  const parsed = useMemo(() => (isStreaming ? null : parseChartSpec(code)), [code, isStreaming]);
  const chartVisible = showChart && !isStreaming;

  // Warm the library while the fence streams; errors surface once it is shown.
  useEffect(() => {
    if (isStreaming && !loadedChart) loadChart().catch(() => {});
  }, [isStreaming]);

  useEffect(() => {
    if (!chartVisible || !parsed?.ok || Chart) return;
    let cancelled = false;
    loadChart()
      .then((loaded) => { if (!cancelled) setChart(() => loaded); })
      // Whatever the import throws, the spec was not the problem.
      .catch((error: unknown) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [chartVisible, parsed, Chart, attempt]);

  const ready = Boolean(chartVisible && parsed?.ok && Chart && !loadError && drawError?.code !== code);
  // Measured before paint, so the first frame already has the right width.
  useLayoutEffect(() => {
    const figure = figureRef.current;
    if (!ready || !figure) return;
    const measure = () => {
      const box = figure.getBoundingClientRect();
      const padding = parseFloat(getComputedStyle(figure).paddingLeft) + parseFloat(getComputedStyle(figure).paddingRight);
      if (box.width > 0) setWidth(chartWidth(box.width - padding));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(figure);
    return () => observer.disconnect();
  }, [ready]);
  const sizedSpec = useMemo(
    () => (parsed?.ok && width ? { ...parsed.spec, width, height: rowChartHeight(parsed.spec, width) } : null),
    [parsed, width],
  );

  const toggle = (
    <button
      type="button"
      onClick={() => setShowChart((value) => !value)}
      disabled={isStreaming}
      title={isStreaming ? t("i18n.previewAfterStreaming") : undefined}
      className={["markdown-code-action", chartVisible ? "is-active" : ""].filter(Boolean).join(" ")}
    >
      {chartVisible ? t("i18n.source") : t("i18n.preview")}
    </button>
  );

  if (!chartVisible || !parsed) {
    return <CodeBlock code={code} lang="chart" headerAction={toggle} isStreaming={isStreaming} />;
  }

  const failure = !parsed.ok ? parsed.error : drawError?.code === code ? drawError.message : loadError;

  const download = () => {
    const figure = figureRef.current;
    const svg = figure?.querySelector("svg");
    if (!figure || !svg) return;
    const xml = chartSvgFile(svg, figure);
    const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
    void downloadUrlAsFile(url, "chart.svg")
      .catch(() => {})
      .finally(() => setTimeout(() => URL.revokeObjectURL(url), 0));
  };

  return (
    <div className="markdown-code-block chart-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">chart</span>
        <div className="markdown-code-actions">
          {failure && loadError && failure === loadError && (
            <button type="button" className="markdown-code-action" onClick={() => { setLoadError(null); setAttempt((value) => value + 1); }}>
              {t("common.retry")}
            </button>
          )}
          {failure && failure !== loadError && fixable && <DiagramFixButton error={failure} fixable promptKey="preview.fixPromptChart" />}
          {ready && (
            <button type="button" className="markdown-code-action" title={t("chart.download")} aria-label={t("chart.download")} onClick={download}>
              SVG
            </button>
          )}
          {toggle}
        </div>
      </div>
      {failure ? (
        <div className="chart-block-body chart-block-error" role="alert">
          <div className="mermaid-error-title">{failure === loadError ? t("diagram.loadFailed") : t("chart.invalid")}</div>
          <pre className="mermaid-error-detail">{failure}</pre>
        </div>
      ) : !ready ? (
        <div className="chart-block-body chart-block-loading" aria-label={t("chart.rendering")} />
      ) : (
        <figure className="chart-block-body chart-block-figure" ref={figureRef}>
          {parsed.ok && (parsed.title || parsed.axes.x || parsed.axes.y) && (
            <figcaption className="chart-block-caption">
              {parsed.title && <span className="chart-block-title">{parsed.title}</span>}
              {(parsed.axes.x || parsed.axes.y) && (
                <span className="chart-block-axes">
                  {[parsed.axes.x && t("chart.axisX", { label: parsed.axes.x }), parsed.axes.y && t("chart.axisY", { label: parsed.axes.y })].filter(Boolean).join(" · ")}
                </span>
              )}
            </figcaption>
          )}
          {sizedSpec && Chart && (
            <ChartBoundary key={code} onError={(message) => setDrawError({ code, message })}>
              <Chart.Root className="chart-block-interactive" highlightOnHover={HIGHLIGHT_ON_HOVER.has(sizedSpec.type) ? "index" : false}>
                <Chart.Chart spec={sizedSpec} />
                <Chart.Tooltip side="top" sideOffset={10}>
                  {({ datum }) => <ChartTooltipCard spec={sizedSpec} datum={datum} locale={locale} getSeriesColor={Chart.getSeriesColor} />}
                </Chart.Tooltip>
              </Chart.Root>
            </ChartBoundary>
          )}
        </figure>
      )}
    </div>
  );
}
