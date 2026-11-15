"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { isImeComposing } from "@/lib/ime";
import { downloadUrlAsFile } from "@/lib/desktop-native";
import {
  HTML_PREVIEW_DEFAULT_HEIGHT,
  HTML_PREVIEW_SANDBOX,
  buildHtmlPreviewDocument,
  clampHtmlPreviewHeight,
  htmlPreviewDownloadSource,
  htmlPreviewFileName,
  htmlPreviewFollowsTheme,
  htmlPreviewHasActiveContent,
  type HtmlPreviewKind,
} from "@/lib/html-preview";
import { getActiveArtifactSession, requestArtifactFix, requestArtifactPrompt, useArtifactFixSessionId, useArtifactPromptSessionId, useActiveArtifactSession } from "@/lib/artifact-store";
import { useHtmlPreviewErrors, useHtmlPreviewFrameMessages, useHtmlPreviewOptions } from "@/hooks/useHtmlPreviewFrame";
import { usePreviewRuntime } from "@/lib/preview-runtime";
import { canStreamPreview } from "@/lib/html-preview-stream";
import { StreamingPreviewFrame } from "./StreamingPreviewFrame";
import { CodeBlock } from "./MermaidBlock";
import { HtmlPreviewErrorBar, formatPreviewErrors } from "./HtmlPreviewErrorBar";

interface HtmlPreviewBlockProps {
  code: string;
  lang: string;
  kind: HtmlPreviewKind;
  isStreaming?: boolean;
  /** An artifact action shown beside the preview/source toggle. */
  headerAction?: ReactNode;
  /** React fences start as source: a snippet should not run until asked. */
  defaultPreview?: boolean;
}


// Blocks seen streaming in this page, keyed by their opening text. The
// streaming bubble and the finished message are different components, so the
// finished block looks itself up here to know it was just generated.
const STREAMED_KEY_LENGTH = 256;
const MAX_STREAMED = 100;
const streamedPreviews = new Set<string>();

function rememberStreamed(code: string): void {
  const key = code.slice(0, STREAMED_KEY_LENGTH);
  if (key.length < 32 || streamedPreviews.has(key)) return;
  streamedPreviews.add(key);
  if (streamedPreviews.size > MAX_STREAMED) streamedPreviews.delete(streamedPreviews.values().next().value!);
}

function wasStreamedHere(code: string): boolean {
  return streamedPreviews.has(code.slice(0, STREAMED_KEY_LENGTH));
}
const KIND_MIME: Record<HtmlPreviewKind, string> = {
  html: "text/html;charset=utf-8",
  svg: "image/svg+xml;charset=utf-8",
  react: "text/javascript;charset=utf-8",
};

/**
 * A complete ```html document or ```svg image rendered in place, with a
 * Source toggle like MermaidBlock. While the message streams, a page that can
 * be drawn faithfully is drawn as it grows in a frame of its own (see
 * lib/html-preview-stream.ts); the rest stay source. Either way the normal
 * preview, which runs the page, only starts once the message has ended:
 * re-mounting a frame on every chunk would re-run the page's scripts.
 */
export function HtmlPreviewBlock({ code, lang, kind, isStreaming, defaultPreview = true, headerAction }: HtmlPreviewBlockProps) {
  const { t } = useI18n();
  const [showPreview, setShowPreview] = useState(() => (
    defaultPreview && (Boolean(isStreaming) || !htmlPreviewHasActiveContent(code) || wasStreamedHere(code))
  ));
  if (isStreaming) rememberStreamed(code);
  const [fullscreen, setFullscreen] = useState(false);
  const [height, setHeight] = useState(HTML_PREVIEW_DEFAULT_HEIGHT);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const previewVisible = showPreview && !isStreaming;
  const options = useHtmlPreviewOptions(`${previewVisible ? 1 : 0}:${isStreaming ? "streaming" : code.length}`);
  const runtimeState = usePreviewRuntime(kind === "react" && previewVisible);
  // React documents inline the bundled runtime, so they wait until it loaded.
  const srcDoc = useMemo(() => (
    kind === "react" && !runtimeState.runtime
      ? null
      : buildHtmlPreviewDocument(kind, code, { ...options, runtime: runtimeState.runtime })
  ), [kind, code, options, runtimeState.runtime]);
  const themed = htmlPreviewFollowsTheme(kind, code);
  const { errors, addError, dismiss } = useHtmlPreviewErrors(code);
  const activeSessionId = useActiveArtifactSession();
  const fixSessionId = useArtifactFixSessionId();
  const promptSessionId = useArtifactPromptSessionId();
  // `sendPrompt` in the page fills the composer of the conversation this block
  // is in; elsewhere (no conversation, another one) it does nothing.
  const onPrompt = activeSessionId && promptSessionId === activeSessionId
    ? (text: string) => { requestArtifactPrompt(getActiveArtifactSession(), text); }
    : undefined;

  useHtmlPreviewFrameMessages(frameRef, {
    onSize: (value) => setHeight(clampHtmlPreviewHeight(value)),
    onError: addError,
    onPrompt,
  }, previewVisible && !fullscreen);

  const previewLabel = kind === "svg" ? t("i18n.previewSvg") : kind === "react" ? t("i18n.previewReact") : t("i18n.previewHtml");
  // While it streams, a page that can be drawn faithfully is drawn as it
  // grows, in a frame of its own; the normal preview takes over when it ends.
  const streamable = (kind === "html" || kind === "svg") && canStreamPreview(kind, code);
  const streamPreview = Boolean(isStreaming) && showPreview && streamable;
  const shown = previewVisible || streamPreview;
  const previewLocked = Boolean(isStreaming) && !streamable;
  const previewButton = (
    <button
      type="button"
      onClick={() => setShowPreview((v) => !v)}
      disabled={previewLocked}
      title={previewLocked ? t("i18n.previewAfterStreaming") : (shown ? t("i18n.source") : previewLabel)}
      className={["markdown-code-action", shown ? "is-active" : ""].filter(Boolean).join(" ")}
    >
      {shown ? t("i18n.source") : t("i18n.preview")}
    </button>
  );

  if (streamPreview && (kind === "html" || kind === "svg")) {
    const title = kind === "svg" ? t("i18n.svgPreview") : t("i18n.htmlPreview");
    const themedNow = htmlPreviewFollowsTheme(kind, code);
    return (
      <div className="markdown-code-block html-preview-block">
        <div className="markdown-code-header">
          <span className="markdown-code-lang">{lang || kind}</span>
          <div className="markdown-code-actions">
            {headerAction}
            {previewButton}
          </div>
        </div>
        <StreamingPreviewFrame
          kind={kind}
          code={code}
          themed={themedNow}
          title={title}
          label={t("artifacts.generating")}
          className={`html-preview-frame${themedNow ? " is-themed" : ""}`}
          style={{ height }}
          onSize={(value) => setHeight(clampHtmlPreviewHeight(value))}
        />
      </div>
    );
  }

  if (!previewVisible) {
    return <CodeBlock code={code} lang={lang} headerAction={previewButton} isStreaming={isStreaming} />;
  }

  const download = () => {
    const url = URL.createObjectURL(new Blob([htmlPreviewDownloadSource(kind, code)], { type: KIND_MIME[kind] }));
    void downloadUrlAsFile(url, htmlPreviewFileName(kind))
      .catch(() => {})
      .finally(() => setTimeout(() => URL.revokeObjectURL(url), 0));
  };

  const canFix = Boolean(activeSessionId && fixSessionId === activeSessionId);
  const fix = () => {
    if (requestArtifactFix(getActiveArtifactSession(), t("preview.fixPromptHtml", { errors: formatPreviewErrors(errors) }))) {
      dismiss();
    }
  };

  const title = kind === "svg" ? t("i18n.svgPreview") : kind === "react" ? t("i18n.reactPreview") : t("i18n.htmlPreview");
  const frameClass = `html-preview-frame${themed ? " is-themed" : ""}`;

  return (
    <div className="markdown-code-block html-preview-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">{lang || kind}</span>
        <div className="markdown-code-actions">
          {headerAction}
          <button
            type="button"
            className="markdown-code-action"
            title={`${t("i18n.downloadFile")} · ${htmlPreviewFileName(kind)}`}
            aria-label={`${t("i18n.downloadFile")} · ${htmlPreviewFileName(kind)}`}
            onClick={download}
          >
            {t("preview.download")}
          </button>
          <button
            type="button"
            className="markdown-code-action"
            title={t("i18n.openFullscreen")}
            aria-label={t("i18n.openFullscreen")}
            onClick={() => setFullscreen(true)}
            disabled={!srcDoc}
          >
            {t("i18n.fullscreen")}
          </button>
          {previewButton}
        </div>
      </div>
      {!srcDoc ? (
        <div className="html-preview-placeholder html-preview-loading" style={{ height: 120 }}>
          {runtimeState.status === "error" ? null : t("preview.loadingComponent")}
        </div>
      ) : fullscreen ? (
        <>
          <div className="html-preview-placeholder" style={{ height }} />
          <HtmlPreviewDialog
            title={title}
            srcDoc={srcDoc}
            themed={themed}
            onClose={() => setFullscreen(false)}
            // The composer is behind the dialog, so the dialog closes to show where the text went.
            onPrompt={onPrompt && ((text) => { onPrompt(text); setFullscreen(false); })}
          />
        </>
      ) : (
        <iframe
          ref={frameRef}
          className={frameClass}
          srcDoc={srcDoc}
          sandbox={HTML_PREVIEW_SANDBOX}
          loading="lazy"
          title={title}
          style={{ height }}
        />
      )}
      <HtmlPreviewErrorBar
        errors={runtimeState.error ? [t("preview.runtimeLoadFailed", { error: runtimeState.error }), ...errors] : errors}
        onFix={canFix && !runtimeState.error ? fix : undefined}
        onDismiss={dismiss}
      />
    </div>
  );
}

function HtmlPreviewDialog({ title, srcDoc, themed, onClose, onPrompt }: { title: string; srcDoc: string; themed: boolean; onClose: () => void; onPrompt?: (text: string) => void }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Links still need routing here; errors were already reported inline.
  useHtmlPreviewFrameMessages(frameRef, { onPrompt });

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
      aria-label={title}
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
          <span className="mermaid-zoom-title">{title}</span>
          <div className="mermaid-zoom-actions">
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
        <iframe
          ref={frameRef}
          className={`html-preview-dialog-frame${themed ? " is-themed" : ""}`}
          srcDoc={srcDoc}
          sandbox={HTML_PREVIEW_SANDBOX}
          title={title}
        />
      </div>
    </dialog>
  );
}
