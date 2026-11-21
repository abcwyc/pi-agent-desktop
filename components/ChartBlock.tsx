"use client";

import { Component, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { downloadUrlAsFile } from "@/lib/desktop-native";
import { parseChartSpec, type CleanChartSpec } from "@/lib/chart-spec";
import { CodeBlock, DiagramFixButton } from "./MermaidBlock";

type ChartComponent = ComponentType<{ spec: CleanChartSpec; className?: string }>;

// diagrammatic's spec entry holds all of its chart forms (about 40 KB gzipped),
// so it loads on the first chart, once per page.
let chartModule: Promise<ChartComponent> | null = null;
function loadChart(): Promise<ChartComponent> {
  chartModule ??= import("diagrammatic/spec").then((module) => module.Chart as unknown as ChartComponent);
  // A failed load is not cached: Retry imports again.
  chartModule.catch(() => { chartModule = null; });
  return chartModule;
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
  const { t } = useI18n();
  const [showChart, setShowChart] = useState(true);
  const [Chart, setChart] = useState<ChartComponent | null>(null);
  // The library could not be loaded: Retry, never "Ask to fix" (the spec may be fine).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drawError, setDrawError] = useState<{ code: string; message: string } | null>(null);
  const figureRef = useRef<HTMLDivElement>(null);
  const parsed = useMemo(() => (isStreaming ? null : parseChartSpec(code)), [code, isStreaming]);
  const chartVisible = showChart && !isStreaming;

  useEffect(() => {
    if (!chartVisible || !parsed?.ok || Chart) return;
    let cancelled = false;
    loadChart()
      .then((loaded) => { if (!cancelled) setChart(() => loaded); })
      // Whatever the import throws, the spec was not the problem.
      .catch((error: unknown) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [chartVisible, parsed, Chart]);

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
  const ready = parsed.ok && !failure && Chart;

  const download = () => {
    const svg = figureRef.current?.querySelector("svg");
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
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
            <button type="button" className="markdown-code-action" onClick={() => setLoadError(null)}>
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
          {parsed.title && <figcaption className="chart-block-title">{parsed.title}</figcaption>}
          <ChartBoundary key={code} onError={(message) => setDrawError({ code, message })}>
            <Chart spec={parsed.spec} />
          </ChartBoundary>
        </figure>
      )}
    </div>
  );
}
