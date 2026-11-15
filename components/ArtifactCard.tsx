"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { shouldInlineArtifact, versionIndexOf, type ArtifactBlock, type ArtifactType } from "@/lib/artifacts";
import { openArtifact, useActiveArtifactSession, useHasArtifactOpener, useSessionArtifact } from "@/lib/artifact-store";
import { HtmlPreviewBlock } from "./HtmlPreviewBlock";
import { CodeBlock, MermaidBlock } from "./MermaidBlock";

export const ARTIFACT_TYPE_LABEL: Record<ArtifactType, string> = {
  html: "HTML",
  svg: "SVG",
  react: "React",
  mermaid: "Mermaid",
  markdown: "Markdown",
  code: "Code",
};

export function ArtifactTypeIcon({ type, size = 16 }: { type: ArtifactType; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (type) {
    case "svg":
      return <svg {...common}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></svg>;
    case "mermaid":
      return <svg {...common}><rect x="3" y="3" width="7" height="5" rx="1" /><rect x="14" y="16" width="7" height="5" rx="1" /><path d="M6.5 8v4.5a2 2 0 0 0 2 2h9V16" /></svg>;
    case "markdown":
      return <svg {...common}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></svg>;
    case "code":
      return <svg {...common}><path d="m16 18 6-6-6-6M8 6l-6 6 6 6" /></svg>;
    case "react":
      return <svg {...common}><circle cx="12" cy="12" r="1.6" /><ellipse cx="12" cy="12" rx="9.5" ry="3.8" /><ellipse cx="12" cy="12" rx="9.5" ry="3.8" transform="rotate(60 12 12)" /><ellipse cx="12" cy="12" rx="9.5" ry="3.8" transform="rotate(120 12 12)" /></svg>;
    default:
      return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></svg>;
  }
}

/**
 * An artifact in a message. Simple content stays part of the reply; larger or
 * runnable content becomes a card that opens the side panel.
 */
export function ArtifactCard({ block, isStreaming }: { block: ArtifactBlock; isStreaming?: boolean }) {
  const { t } = useI18n();
  const sessionId = useActiveArtifactSession();
  const entry = useSessionArtifact(sessionId, block.identifier);
  const generating = !block.complete && Boolean(isStreaming);
  const versionIndex = generating ? -1 : versionIndexOf(entry, block);
  const sawGeneratingRef = useRef(false);
  const stagedRef = useRef(false);
  const [readyHighlight, setReadyHighlight] = useState(false);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLButtonElement>(null);
  const hasOpener = useHasArtifactOpener();
  const handleOpen = useCallback(() => openArtifact({
    identifier: block.identifier,
    title: block.title,
    ...(versionIndex >= 0 ? { version: versionIndex + 1 } : {}),
    reveal: true,
  }), [block.identifier, block.title, versionIndex]);

  useEffect(() => {
    if (generating) {
      sawGeneratingRef.current = true;
      // A page is drawn in the panel while it is written, so its tab is staged
      // when the writing starts, not when it ends. Staging never opens a closed panel.
      if (!stagedRef.current && (block.type === "html" || block.type === "svg")) {
        stagedRef.current = true;
        openArtifact({ identifier: block.identifier, title: block.title, auto: true, reveal: false });
      }
      return;
    }
    if (!sawGeneratingRef.current || !block.complete) return;
    sawGeneratingRef.current = false;
    stagedRef.current = false;
    setReadyHighlight(true);
    if (readyTimerRef.current) clearTimeout(readyTimerRef.current);
    readyTimerRef.current = setTimeout(() => setReadyHighlight(false), 2600);
    const rect = cardRef.current?.getBoundingClientRect();
    if (rect && (rect.bottom < 48 || rect.top > window.innerHeight - 120)) {
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    openArtifact({
      identifier: block.identifier,
      title: block.title,
      ...(versionIndex >= 0 ? { version: versionIndex + 1 } : {}),
      auto: true,
      reveal: false,
    });
  }, [generating, block.complete, block.type, block.identifier, block.title, versionIndex]);

  useEffect(() => () => {
    if (readyTimerRef.current) clearTimeout(readyTimerRef.current);
  }, []);

  // A markdown preview outside the chat has no panel. In the chat, diagrams
  // and short documents render in place; apps and scripted pages do not.
  if (!hasOpener || shouldInlineArtifact(block)) {
    return <InlineArtifact block={block} isStreaming={isStreaming} onOpen={hasOpener ? handleOpen : undefined} />;
  }

  const versionCount = entry?.versions.length ?? 0;
  const subtitle = generating
    ? t("artifacts.generating")
    : [
        ARTIFACT_TYPE_LABEL[block.type],
        versionIndex >= 0 && versionCount > 1 ? t("artifacts.versionOf", { version: versionIndex + 1, total: versionCount }) : null,
      ].filter(Boolean).join(" · ");

  return (
    <button
      ref={cardRef}
      type="button"
      className={`artifact-card${generating ? " is-generating" : ""}${readyHighlight ? " artifact-ready" : ""}`}
      onClick={handleOpen}
      title={generating ? t("artifacts.generating") : t("artifacts.staged")}
    >
      <span className="artifact-card-icon">
        <ArtifactTypeIcon type={block.type} />
      </span>
      <span className="artifact-card-text">
        <span className="artifact-card-title">{block.title}</span>
        <span className="artifact-card-subtitle">{subtitle}</span>
      </span>
      <span className="artifact-card-action">{t("artifacts.open")}</span>
    </button>
  );
}

function InlineArtifact({
  block,
  isStreaming,
  onOpen,
}: {
  block: ArtifactBlock;
  isStreaming?: boolean;
  onOpen?: () => void;
}) {
  const { t } = useI18n();
  const streaming = Boolean(isStreaming) && !block.complete;
  const action: ReactNode = onOpen && !streaming ? (
    <button
      type="button"
      className="markdown-code-action artifact-inline-open"
      title={block.title}
      onClick={onOpen}
    >
      <ArtifactTypeIcon type={block.type} size={12} />
      {t("artifacts.open")}
    </button>
  ) : undefined;
  if (block.type === "html" || block.type === "svg" || block.type === "react") {
    return <HtmlPreviewBlock code={block.content} lang={block.lang} kind={block.type} isStreaming={streaming} headerAction={action} />;
  }
  if (block.type === "mermaid") {
    return <MermaidBlock code={block.content} isStreaming={streaming} defaultPreview headerAction={action} />;
  }
  return <CodeBlock code={block.content} lang={block.lang} isStreaming={streaming} headerAction={action} />;
}
