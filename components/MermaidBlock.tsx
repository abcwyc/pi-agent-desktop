"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { SyntaxHighlighter } from "@/lib/syntax-highlighting";
import { calmCodeTheme } from "@/lib/code-theme";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { isImeComposing } from "@/lib/ime";

interface MermaidBlockProps {
  code: string;
  isStreaming?: boolean;
  defaultPreview?: boolean;
  /**
   * Scale the diagram to the width it is shown in (see `.mermaid-fit` in
   * native-theme.css). Mermaid sizes its SVG to `width: 100%` capped at the
   * diagram's natural width, so by default a narrow diagram stays small and a
   * wide one shrinks until its text is unreadable.
   */
  fit?: boolean;
  /** An artifact action shown beside the preview/source toggle. */
  headerAction?: ReactNode;
}

// Without a readable viewBox the variable stays unset and the CSS falls back
// to the plain width: a 0px natural width would hide the diagram entirely.
function fitStyle(fit: boolean, svg: string): CSSProperties | undefined {
  const width = fit ? mermaidNaturalWidth(svg) : null;
  return width ? ({ "--mermaid-natural-width": `${width}px` } as CSSProperties) : undefined;
}

/** The natural width of a rendered Mermaid SVG, from its viewBox. */
export function mermaidNaturalWidth(svg: string): number | null {
  const match = /<svg\b[^>]*?\sviewBox="\s*-?[\d.]+[\s,]+-?[\d.]+[\s,]+([\d.]+)[\s,]+[\d.]+\s*"/i.exec(svg);
  const width = match ? Number(match[1]) : NaN;
  return Number.isFinite(width) && width > 0 ? width : null;
}

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

export function downloadMermaidSvg(svg: SVGSVGElement): void {
  // Mermaid's HTML serialization can leave void tags such as <br> unclosed.
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "mermaid-diagram.svg";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

type RenderState =
  | { key: string; status: "loading" }
  | { key: string; status: "error" }
  | { key: string; status: "ready"; svg: string };

/** Renders a diagram to an SVG string (strict security level); rejects on invalid input. */
export async function renderMermaidSvg(code: string, isDark: boolean): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: isDark ? "dark" : "default",
  });

  const parsed = await mermaid.parse(code, { suppressErrors: true });
  if (!parsed) throw new Error("Invalid Mermaid diagram");

  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `mermaid-${crypto.randomUUID()}`
      : `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return (await mermaid.render(id, code)).svg;
}

export function MermaidBlock({ code, isStreaming, defaultPreview = false, fit = false, headerAction }: MermaidBlockProps) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  const [showPreview, setShowPreview] = useState(defaultPreview);
  const [renderState, setRenderState] = useState<RenderState | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const previewRef = useRef<HTMLButtonElement>(null);
  const [previewZoom, setPreviewZoom] = useState(1);
  const currentKey = `${isDark ? "dark" : "light"}\n${code}`;
  const previewVisible = showPreview && !isStreaming;

  const updatePreviewZoom = useCallback((delta: number) => {
    setPreviewZoom((zoom) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom + delta)));
  }, []);

  const resetPreviewZoom = useCallback(() => setPreviewZoom(1), []);

  useEffect(() => {
    if (previewVisible) setPreviewZoom(1);
  }, [previewVisible]);

  // Ctrl/⌘ + wheel zooms the diagram. React attaches wheel listeners as
  // passive, where preventDefault is ignored and the whole page zooms too.
  const previewMounted = previewVisible && !zoomOpen && renderState?.key === currentKey && renderState.status === "ready";
  useEffect(() => {
    const preview = previewRef.current;
    if (!previewMounted || !preview) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      updatePreviewZoom(event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP);
    };
    preview.addEventListener("wheel", onWheel, { passive: false });
    return () => preview.removeEventListener("wheel", onWheel);
  }, [previewMounted, updatePreviewZoom]);

  useEffect(() => {
    if (!previewVisible) return;

    let cancelled = false;
    setRenderState({ key: currentKey, status: "loading" });

    renderMermaidSvg(code, isDark).then((svg) => {
      if (!cancelled) setRenderState({ key: currentKey, status: "ready", svg });
    }).catch(() => {
      if (!cancelled) setRenderState({ key: currentKey, status: "error" });
    });

    return () => {
      cancelled = true;
    };
  }, [code, currentKey, isDark, previewVisible]);

  const previewButton = useMemo(() => (
    <button
      type="button"
      onClick={() => setShowPreview((v) => !v)}
      disabled={isStreaming}
      title={isStreaming ? t("i18n.previewAfterStreaming") : (previewVisible ? t("i18n.showMermaidSource") : t("i18n.previewMermaid"))}
      className={["markdown-code-action", previewVisible ? "is-active" : ""].filter(Boolean).join(" ")}
    >
      {previewVisible ? t("i18n.source") : t("i18n.preview")}
    </button>
  ), [isStreaming, previewVisible, t]);

  if (!previewVisible) {
    return <CodeBlock code={code} lang="mermaid" headerAction={previewButton} isStreaming={isStreaming} />;
  }

  const body = renderState?.key === currentKey && renderState.status === "error" ? (
      <div className="mermaid-block mermaid-block-error">{t("i18n.invalidMermaid")}</div>
    ) : renderState?.key !== currentKey || renderState.status !== "ready" ? (
      <div className="mermaid-block mermaid-block-loading" aria-label={t("i18n.renderingMermaid")} />
    ) : (
      <>
        {!zoomOpen && (
          <button
            ref={previewRef}
            type="button"
            className={`mermaid-block mermaid-preview-button${fit ? " mermaid-fit" : ""}`}
            style={{
              ...fitStyle(fit, renderState.svg),
              "--mermaid-preview-zoom": previewZoom,
            } as CSSProperties}
            title={t("i18n.openMermaidViewer")}
            aria-label={t("i18n.openMermaidViewer")}
            onClick={() => setZoomOpen(true)}
            onDoubleClick={(event) => {
              event.stopPropagation();
              resetPreviewZoom();
            }}
            onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
              if (isImeComposing(event)) return;
              if (event.key === "+" || event.key === "=") {
                event.preventDefault();
                updatePreviewZoom(ZOOM_STEP);
              }
              if (event.key === "-" || event.key === "_") {
                event.preventDefault();
                updatePreviewZoom(-ZOOM_STEP);
              }
              if (event.key === "0") {
                event.preventDefault();
                resetPreviewZoom();
              }
            }}
            dangerouslySetInnerHTML={{ __html: renderState.svg }}
          />
        )}
        {zoomOpen && <MermaidZoomDialog svg={renderState.svg} onClose={() => setZoomOpen(false)} />}
      </>
    );

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">mermaid</span>
        <div className="markdown-code-actions">
          {headerAction}
          {renderState?.key === currentKey && renderState.status === "ready" && (
            <button
              type="button"
              className="markdown-code-action"
              title={`${t("i18n.downloadFile")} (SVG)`}
              aria-label={`${t("i18n.downloadFile")} (SVG)`}
              onClick={() => {
                const svg = previewRef.current?.querySelector("svg");
                if (svg) downloadMermaidSvg(svg);
              }}
            >
              SVG
            </button>
          )}
          {previewButton}
        </div>
      </div>
      {body}
    </div>
  );
}

function MermaidZoomDialog({ svg, onClose }: { svg: string; onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();

    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="mermaid-zoom-dialog"
      aria-label={t("i18n.mermaidViewer")}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || isImeComposing(event)) return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="mermaid-zoom-layout">
        <div className="mermaid-zoom-toolbar">
          <span className="mermaid-zoom-title">{t("i18n.mermaidDiagram")}</span>
          <div className="mermaid-zoom-actions">
            <div className="mermaid-zoom-stepper">
              <button
                type="button"
                onClick={() => setZoom((value) => Math.max(ZOOM_MIN, value - ZOOM_STEP))}
                disabled={zoom <= ZOOM_MIN}
                title={t("i18n.zoomOut")}
                aria-label={t("i18n.zoomOut")}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M5 12h14" />
                </svg>
              </button>
              <span className="mermaid-zoom-value">{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                onClick={() => setZoom((value) => Math.min(ZOOM_MAX, value + ZOOM_STEP))}
                disabled={zoom >= ZOOM_MAX}
                title={t("i18n.zoomIn")}
                aria-label={t("i18n.zoomIn")}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
            <button
              type="button"
              className="mermaid-zoom-icon-button"
              onClick={() => setZoom(1)}
              title={t("i18n.fitToWidth")}
              aria-label={t("i18n.fitToWidth")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
              </svg>
            </button>
            <button
              type="button"
              className="mermaid-zoom-icon-button"
              onClick={onClose}
              title={t("i18n.close")}
              aria-label={t("i18n.close")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        </div>
        <div
          className="mermaid-zoom-viewport"
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <div
            className="mermaid-zoom-canvas"
            style={{ width: `${zoom * 100}%` }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </dialog>
  );
}

/** Blocks longer than this fold to their first lines until expanded. */
export const CODE_FOLD_LINES = 30;
/** A one- or two-line snippet (a command, a path) reads better without a gutter. */
export const CODE_LINE_NUMBER_MIN_LINES = 3;

export function codeLineCount(code: string): number {
  return code.replace(/\n$/, "").split("\n").length;
}

interface CodeBlockProps {
  code: string;
  lang: string;
  headerAction?: ReactNode;
  isStreaming?: boolean;
}

/**
 * Syntax-highlighted code block with copy button.
 * Used as the "source" view for mermaid blocks and for all non-mermaid code fences.
 * Memoized because Prism tokenization is expensive; for plain fences (no
 * headerAction) props are stable across parent re-renders. While the owning
 * message is still streaming, the block renders as plain monospace text —
 * highlighting a growing block re-tokenizes all of it on every chunk.
 */
export const CodeBlock = memo(function CodeBlock({ code, lang, headerAction, isStreaming }: CodeBlockProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  // Long lines wrap by default, as pi's TUI shows them (C10, upstream #1369).
  const [wrap, setWrap] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const lineCount = codeLineCount(code);
  // A block keeps growing while it streams, so it only folds once complete.
  const foldable = !isStreaming && lineCount > CODE_FOLD_LINES;
  const folded = foldable && !expanded;
  const showLineNumbers = lineCount >= CODE_LINE_NUMBER_MIN_LINES;

  const copy = () => {
    copyText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">{lang || "text"}</span>
        <div className="markdown-code-actions">
          {headerAction}
          <button
            onClick={() => setWrap((value) => !value)}
            className={`markdown-code-action${wrap ? " is-active" : ""}`}
            aria-pressed={wrap}
          >
            {wrap ? t("chat.codeNoWrap") : t("chat.codeWrap")}
          </button>
          <button
            onClick={copy}
            className="markdown-code-action"
          >
            {copied ? t("i18n.copied") : t("i18n.copy")}
          </button>
        </div>
      </div>
      <div className={`markdown-code-body${folded ? " is-folded" : ""}${wrap ? " is-wrapped" : ""}`}>
      {isStreaming ? (
        <pre
          style={{
            margin: 0,
            padding: "11px 13px",
            fontSize: "calc(12.5px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.62,
            overflowX: "auto",
            backgroundColor: "color-mix(in srgb, var(--bg) 92%, var(--bg-panel))",
          }}
        >
          <code style={{ fontFamily: "var(--font-mono)" }}>{code}</code>
        </pre>
      ) : (
        <SyntaxHighlighter
          language={lang || "text"}
          style={calmCodeTheme}
          showLineNumbers={showLineNumbers}
          lineNumberStyle={{ color: "var(--text-dim)", fontStyle: "normal" }}
          customStyle={{
            margin: 0,
            padding: "11px 13px",
            fontSize: "calc(12.5px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.62,
            // The wrapper draws the frame; the theme carries no border or background.
            border: "none",
            borderRadius: 0,
            backgroundColor: "color-mix(in srgb, var(--bg) 92%, var(--bg-panel))",
          }}
          codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
        >
          {code}
        </SyntaxHighlighter>
      )}
      </div>
      {foldable && (
        <button
          type="button"
          className="markdown-code-fold"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("chat.codeCollapse") : t("chat.codeExpand", { count: lineCount })}
        </button>
      )}
    </div>
  );
});
