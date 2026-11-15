"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { downloadUrlAsFile } from "@/lib/desktop-native";
import { artifactFileName, artifactHasActiveContent, type ArtifactVersion } from "@/lib/artifacts";
import { HTML_PREVIEW_SANDBOX, buildHtmlPreviewDocument, htmlPreviewDownloadSource, htmlPreviewFollowsTheme } from "@/lib/html-preview";
import { useHtmlPreviewErrors, useHtmlPreviewFrameMessages, useHtmlPreviewOptions } from "@/hooks/useHtmlPreviewFrame";
import { usePreviewRuntime } from "@/lib/preview-runtime";
import { canStreamPreview } from "@/lib/html-preview-stream";
import { StreamingPreviewFrame } from "./StreamingPreviewFrame";
import { ArtifactTypeIcon, ARTIFACT_TYPE_LABEL } from "./ArtifactCard";
import { HtmlPreviewErrorBar, formatPreviewErrors } from "./HtmlPreviewErrorBar";
import { MarkdownBody } from "./MarkdownBody";
import { CodeBlock, MermaidBlock } from "./MermaidBlock";

export interface ArtifactViewProps {
  identifier: string;
  /** Shown while there is nothing to render. */
  title: string;
  versions: readonly ArtifactVersion[] | undefined;
  /** A version picked from outside; `nonce` makes repeat clicks count. */
  versionRequest?: { version?: number; nonce: number };
  /** Sends a fix request; the error bar offers "Ask to fix" only when given. Returns false when nothing was sent. */
  onFix?: (text: string) => boolean;
  /** Puts a page's `sendPrompt` text in the composer; the page's request is dropped without it. */
  onPrompt?: (text: string) => boolean;
  /**
   * Show the source of scripted content until the user picks Preview. For
   * surfaces that open history, which must not run code on their own.
   */
  holdActiveContent?: boolean;
  /** Extra words for the toolbar meta line of the shown version. */
  versionNote?: (index: number) => string | null;
  /** Extra toolbar buttons for the shown version. */
  renderControls?: (index: number) => ReactNode;
  emptyMessage: string;
}

const MIME_TYPES: Record<ArtifactVersion["type"], string> = {
  html: "text/html;charset=utf-8",
  react: "text/javascript;charset=utf-8",
  svg: "image/svg+xml;charset=utf-8",
  mermaid: "text/plain;charset=utf-8",
  markdown: "text/markdown;charset=utf-8",
  code: "text/plain;charset=utf-8",
};

export const ARTIFACT_TOOLBAR_ICON = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const ICON = ARTIFACT_TOOLBAR_ICON;

/**
 * One artifact with its versions: toolbar, preview or source, error bar. It
 * follows the newest version unless the user picked an older one, so an
 * artifact that is being regenerated updates in place. The toolbar is
 * FileViewer's (same classes), so it reads like a file tab. Used by the
 * right-panel tab and the Artifacts page.
 */
export function ArtifactView({ identifier, title, versions, versionRequest, onFix, onPrompt, holdActiveContent = false, versionNote, renderControls, emptyMessage }: ArtifactViewProps) {
  const { t } = useI18n();
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
  // null: the default for the version (source when held, else preview).
  const [showSource, setShowSource] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!versionRequest) return;
    setPinnedIndex(versionRequest.version ? versionRequest.version - 1 : null);
  }, [versionRequest]);

  const total = versions?.length ?? 0;
  const latestIndex = total - 1;
  const index = pinnedIndex !== null && pinnedIndex >= 0 && pinnedIndex < total ? pinnedIndex : latestIndex;
  const version = index >= 0 ? versions?.[index] : undefined;
  const generating = Boolean(version && !version.complete);
  const previewable = Boolean(version && version.type !== "code");
  const held = Boolean(holdActiveContent && version && artifactHasActiveContent(version));
  const frameKind = version && (version.type === "html" || version.type === "svg" || version.type === "react") ? version.type : null;
  // A page that is still being written is drawn as it grows, unless the user
  // asked for the source or it cannot be drawn faithfully yet (lib/html-preview-stream.ts).
  const streamKind = generating && version && (frameKind === "html" || frameKind === "svg") && canStreamPreview(frameKind, version.content) ? frameKind : null;
  const streaming = Boolean(streamKind) && showSource !== true;
  const sourceVisible = (showSource ?? held) || (generating && !streaming) || !previewable;
  const framed = Boolean(frameKind && !sourceVisible && !streaming);
  const options = useHtmlPreviewOptions(`${identifier}:${index}:${framed ? 1 : 0}:${generating ? "generating" : version?.content.length ?? 0}`);

  const runtimeState = usePreviewRuntime(framed && frameKind === "react");
  // React documents inline the bundled runtime, so they wait until it loaded.
  const srcDoc = useMemo(() => (
    version && framed && frameKind && (frameKind !== "react" || runtimeState.runtime)
      ? buildHtmlPreviewDocument(frameKind, version.content, { ...options, runtime: runtimeState.runtime })
      : null
  ), [version, framed, frameKind, options, runtimeState.runtime]);

  const { errors, addError, dismiss } = useHtmlPreviewErrors(`${identifier}:${index}:${version?.content.length ?? 0}`);
  useHtmlPreviewFrameMessages(frameRef, { onError: addError, onPrompt: onPrompt && ((text) => { onPrompt(text); }) }, framed);

  if (!version) {
    return (
      <div className="artifact-panel artifact-panel-empty">
        <p>{emptyMessage || title}</p>
      </div>
    );
  }

  const selectVersion = (next: number) => setPinnedIndex(next >= latestIndex ? null : next);

  const copy = () => {
    void copyText(version.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([frameKind ? htmlPreviewDownloadSource(frameKind, version.content) : version.content], { type: MIME_TYPES[version.type] }));
    void downloadUrlAsFile(url, artifactFileName(identifier, version))
      .catch(() => {})
      .finally(() => setTimeout(() => URL.revokeObjectURL(url), 0));
  };

  const fix = onFix && (() => {
    const text = t("preview.fixPromptArtifact", {
      title: version.title,
      identifier,
      version: index + 1,
      errors: formatPreviewErrors(errors),
    });
    if (onFix(text)) dismiss();
  });

  const meta = [
    ARTIFACT_TYPE_LABEL[version.type],
    generating ? t("artifacts.generating") : null,
    versionNote?.(index) ?? null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="artifact-panel">
      <div className="file-viewer-toolbar artifact-panel-toolbar">
        <div className="file-viewer-identity">
          <span className="file-viewer-file-icon" aria-hidden="true">
            <ArtifactTypeIcon type={version.type} size={15} />
          </span>
          <span className="file-viewer-path" title={version.title}>{version.title}</span>
          <span className="file-viewer-meta">{meta}</span>
        </div>
        <div className="file-viewer-controls">
          {total > 1 && (
            <span className="artifact-panel-versions" role="group" aria-label={t("artifacts.versions")}>
              <button
                type="button"
                className="file-viewer-icon-button"
                onClick={() => selectVersion(index - 1)}
                disabled={index <= 0}
                title={t("artifacts.previousVersion")}
                aria-label={t("artifacts.previousVersion")}
              >
                <svg {...ICON}><path d="m15 18-6-6 6-6" /></svg>
              </button>
              <span className="artifact-panel-version-label">
                {t("artifacts.versionOf", { version: index + 1, total })}
              </span>
              <button
                type="button"
                className="file-viewer-icon-button"
                onClick={() => selectVersion(index + 1)}
                disabled={index >= latestIndex}
                title={t("artifacts.nextVersion")}
                aria-label={t("artifacts.nextVersion")}
              >
                <svg {...ICON}><path d="m9 18 6-6-6-6" /></svg>
              </button>
            </span>
          )}
          {previewable && (
            <div className="file-viewer-mode-switch" aria-label={t("i18n.fileViewMode")}>
              {([false, true] as const).map((source) => {
                const active = (sourceVisible && !streaming) === source;
                return (
                  <button
                    key={String(source)}
                    type="button"
                    className="file-viewer-mode-button"
                    aria-pressed={active}
                    disabled={generating && !source && !streamKind}
                    title={generating && !source ? t("i18n.previewAfterStreaming") : undefined}
                    onClick={() => setShowSource(source)}
                  >
                    {source ? t("i18n.source") : t("i18n.preview")}
                  </button>
                );
              })}
            </div>
          )}
          {renderControls?.(index)}
          <button
            type="button"
            className="file-viewer-icon-button"
            onClick={copy}
            title={copied ? t("i18n.copied") : t("i18n.copy")}
            aria-label={copied ? t("i18n.copied") : t("i18n.copy")}
          >
            {copied ? (
              <svg {...ICON}><path d="M20 6 9 17l-5-5" /></svg>
            ) : (
              <svg {...ICON}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            )}
          </button>
          <button
            type="button"
            className="file-viewer-icon-button"
            onClick={download}
            disabled={generating}
            title={t("i18n.downloadFile")}
            aria-label={t("i18n.downloadFile")}
          >
            <svg {...ICON}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>
      <HtmlPreviewErrorBar
        errors={framed ? (runtimeState.error ? [t("preview.runtimeLoadFailed", { error: runtimeState.error }), ...errors] : errors) : []}
        onFix={fix && !runtimeState.error ? fix : undefined}
        onDismiss={dismiss}
      />
      <div className={`artifact-panel-body${srcDoc || streaming ? " is-frame" : ""}`}>
        {streaming && streamKind && version ? (
          <StreamingPreviewFrame
            key={`${identifier}:${index}`}
            kind={streamKind}
            code={version.content}
            themed={htmlPreviewFollowsTheme(streamKind, version.content)}
            title={version.title}
            label={t("artifacts.generating")}
            className={`artifact-panel-frame${htmlPreviewFollowsTheme(streamKind, version.content) ? " is-themed" : ""}`}
          />
        ) : sourceVisible ? (
          <CodeBlock code={version.content} lang={version.lang} isStreaming={generating} />
        ) : srcDoc ? (
          <iframe
            ref={frameRef}
            key={`${identifier}:${index}`}
            className={`artifact-panel-frame${frameKind && htmlPreviewFollowsTheme(frameKind, version.content) ? " is-themed" : ""}`}
            srcDoc={srcDoc}
            sandbox={HTML_PREVIEW_SANDBOX}
            title={version.title}
          />
        ) : framed ? (
          <div className="artifact-panel artifact-panel-empty">
            {runtimeState.status === "error" ? null : t("preview.loadingComponent")}
          </div>
        ) : version.type === "mermaid" ? (
          <MermaidBlock key={`${identifier}:${index}`} code={version.content} defaultPreview fit />
        ) : (
          <MarkdownBody className="artifact-panel-markdown">{version.content}</MarkdownBody>
        )}
      </div>
    </div>
  );
}
