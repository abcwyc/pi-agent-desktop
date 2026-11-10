"use client";

import { createContext, memo, useContext, useEffect, useMemo, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { type Components, type ExtraProps } from "react-markdown";
import { useStreamingMarkdownText } from "@/hooks/useStreamingMarkdown";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { useFileContextMenu } from "@/hooks/useFileContextMenu";
import { useI18n } from "@/hooks/useI18n";
import { fenceFilePaths, inlineCodeFilePath } from "@/lib/file-context-menu";
import { parsePdfPageFragment, resolveLocalFileHref, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { isExternalMarkdownHref, markdownAppUrlTransform, markdownDocumentRehypePlugins, markdownRehypePlugins, markdownRemarkPlugins, markdownTextLayoutRemarkPlugins, markdownUrlTransform, markdownUserRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { isAudioPath, isVideoPath } from "@/lib/file-types";
import { copyText } from "@/lib/clipboard";
import { ImagePreview } from "./ImagePreview";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";
import { HtmlPreviewBlock } from "./HtmlPreviewBlock";
import { htmlPreviewKind } from "@/lib/html-preview";
import { ArtifactCard } from "./ArtifactCard";
import { ARTIFACT_FENCE_LANG, decodeArtifactFence, encodeArtifactsForMarkdown } from "@/lib/artifacts";
import { handleExternalLinkClick, openPathNative } from "@/lib/desktop-native";
import { isTauriDesktop } from "@/lib/desktop-updater";

const MarkdownLinkContext = createContext(false);

// One shared empty map: a fresh Map per streamed delta would rebuild `components` and re-parse every completed block.
const NO_FENCE_FILES: Map<number, string> = new Map();

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** Render every line ending as a line break, for text the user typed. */
  keepLineBreaks?: boolean;
  /** An extension's custom message: keepLineBreaks, plus each paragraph line's indent, as in pi's TUI. */
  keepTextLayout?: boolean;
  /** A document reader (a skill's instructions): relative links call this instead of leaving the app; headings get anchors. */
  onNavigateLink?: (href: string) => void;
  /** Render `:::artifact{...}` blocks as artifact cards (assistant text only). */
  artifacts?: boolean;
}

function MarkdownImage({
  src,
  alt,
  cwd,
  ...props
}: ComponentProps<"img"> & ExtraProps & { cwd?: string }) {
  const insideLink = useContext(MarkdownLinkContext);
  delete props.node;
  const href = typeof src === "string" ? src : undefined;
  const filePath = href ? resolveLocalFileHref(href, cwd) : null;
  const imageSrc = filePath
    ? `/api/files/${encodeFilePathForApi(filePath)}?type=read`
    : href;
  // `![](take.wav)` is how a model shows a sound or clip it made, and an <img>
  // cannot play it (C9). The file API already streams both with range requests.
  const mediaPath = filePath ?? href?.split(/[?#]/, 1)[0] ?? "";
  const label = alt?.trim() ? alt : undefined;
  if (isAudioPath(mediaPath)) {
    return <audio className="markdown-media" controls preload="metadata" src={imageSrc} aria-label={label} />;
  }
  if (isVideoPath(mediaPath)) {
    return <video className="markdown-media" controls playsInline preload="metadata" src={imageSrc} aria-label={label} />;
  }
  // Dynamic local paths are served directly by the file API.
  // eslint-disable-next-line @next/next/no-img-element
  const image = <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
  if (!imageSrc || insideLink) return image;
  return (
    <ImagePreview src={imageSrc} alt={alt ?? ""} className="markdown-image">
      {image}
    </ImagePreview>
  );
}

/** Inline code that may name a file: right-click offers the file menu once the server confirms it exists. */
/**
 * A display formula with a Copy button for its LaTeX (C8, upstream #1380). The
 * source comes from lib/markdown.ts's `data-math-source`, set after sanitizing,
 * so it is always the LaTeX the model wrote, never KaTeX's glyphs.
 */
function MathDisplay({ source, children }: { source: string; children: ReactNode }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    copyText(source).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <div className="markdown-math-display">
      {children}
      <button type="button" onClick={copy} className="markdown-code-action markdown-math-copy">
        {copied ? t("i18n.copied") : t("i18n.copy")}
      </button>
    </div>
  );
}

function MarkdownInlineCode({
  cwd,
  onOpenFile,
  children,
  ...props
}: ComponentProps<"code"> & ExtraProps & {
  cwd: string | undefined;
  onOpenFile: ((filePath: string, page?: number) => void) | undefined;
}) {
  delete props.node;
  const showFileMenu = useFileContextMenu(onOpenFile);
  return (
    <code
      className="markdown-inline-code"
      {...props}
      onContextMenu={onOpenFile ? (event) => {
        const filePath = inlineCodeFilePath(String(children), cwd);
        if (filePath) showFileMenu(event, { filePath, verify: true });
      } : undefined}
    >
      {children}
    </code>
  );
}

/** "Open" beside Copy on a code block the prose above attributes to a saved file; shown once the server confirms the file exists. */
function CodeBlockOpenFile({ filePath, onOpenFile }: { filePath: string; onOpenFile: (filePath: string) => void }) {
  const { t } = useI18n();
  const [exists, setExists] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setExists(false);
    fetch(`/api/files/${encodeFilePathForApi(filePath)}?type=meta`)
      .then((res) => { if (!cancelled) setExists(res.ok); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [filePath]);
  if (!exists) return null;
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  return (
    <>
      <button
        type="button"
        className="markdown-code-action"
        title={t("chat.openWrittenFile", { name })}
        onClick={() => onOpenFile(filePath)}
      >
        {t("sidebar.open")}
      </button>
      {isTauriDesktop() && (
        <button
          type="button"
          className="markdown-code-action"
          title={t("chat.openDefaultAppTitle", { name })}
          onClick={() => { openPathNative(filePath).catch((error) => console.error("Open with default app failed", error)); }}
        >
          {t("chat.openDefaultApp")}
        </button>
      )}
    </>
  );
}

/** A markdown link to a local file; right-click offers the file menu. */
function MarkdownLocalFileLink({
  filePath,
  page,
  onOpenFile,
  children,
  ...props
}: ComponentProps<"a"> & ExtraProps & {
  filePath: string;
  page: number | undefined;
  onOpenFile: (filePath: string, page?: number) => void;
}) {
  delete props.node;
  const showFileMenu = useFileContextMenu(onOpenFile);
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldOpenLocalFileInApp(event)) return;
    const target = event.currentTarget.getAttribute("target");
    if (target && target !== "_self") return;
    event.preventDefault();
    onOpenFile(filePath, page);
  };
  return (
    <MarkdownLinkContext.Provider value={true}>
      <a
        {...props}
        onClick={handleClick}
        onContextMenu={(event) => showFileMenu(event, { filePath, page })}
      >
        {children}
      </a>
    </MarkdownLinkContext.Provider>
  );
}

function buildComponents(
  isStreaming: boolean | undefined,
  cwd: string | undefined,
  onOpenFile: ((filePath: string, page?: number) => void) | undefined,
  fenceFiles: Map<number, string>,
  onNavigateLink?: (href: string) => void,
): Components {
  return {
    code({ className, children, node, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === ARTIFACT_FENCE_LANG) {
          const artifact = decodeArtifactFence(raw);
          if (artifact) return <ArtifactCard block={artifact} isStreaming={isStreaming} />;
        }
        if (lang === "mermaid") {
          return (
            <MermaidBlock
              code={raw.replace(/\n$/, "")}
              isStreaming={isStreaming}
              defaultPreview
            />
          );
        }
        const previewKind = htmlPreviewKind(lang, raw);
        if (previewKind) {
          return (
            <HtmlPreviewBlock
              code={raw.replace(/\n$/, "")}
              lang={lang}
              kind={previewKind}
              isStreaming={isStreaming}
              defaultPreview={previewKind !== "react"}
            />
          );
        }
        const savedPath = !isStreaming && onOpenFile ? fenceFiles.get(node?.position?.start.line ?? 0) : undefined;
        return (
          <CodeBlock
            code={raw.replace(/\n$/, "")}
            lang={lang}
            isStreaming={isStreaming}
            headerAction={savedPath && onOpenFile ? <CodeBlockOpenFile filePath={savedPath} onOpenFile={onOpenFile} /> : undefined}
          />
        );
      }
      return (
        <MarkdownInlineCode cwd={cwd} onOpenFile={onOpenFile} {...props}>
          {children}
        </MarkdownInlineCode>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      if (onNavigateLink && href && !isExternalMarkdownHref(href)) {
        // No href: a middle-click or "Open in new tab" would load the path on the app's own URL (M7).
        const navigate = () => onNavigateLink(href);
        return (
          <MarkdownLinkContext.Provider value={true}>
            <a {...props} role="link" tabIndex={0} onClick={navigate} onKeyDown={(event) => { if (event.key === "Enter") navigate(); }}>
              {children}
            </a>
          </MarkdownLinkContext.Provider>
        );
      }
      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (!filePath || !openFile) {
        return (
          <MarkdownLinkContext.Provider value={true}>
            <a
              href={href}
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => handleExternalLinkClick(event, href)}
            >
              {children}
            </a>
          </MarkdownLinkContext.Provider>
        );
      }

      return (
        <MarkdownLocalFileLink
          href={href}
          {...props}
          filePath={filePath}
          page={parsePdfPageFragment(href) ?? undefined}
          onOpenFile={openFile}
        >
          {children}
        </MarkdownLocalFileLink>
      );
    },
    img(props) {
      return <MarkdownImage cwd={cwd} {...props} />;
    },
    div({ node, children, ...props }) {
      const source = node?.properties?.dataMathSource;
      if (typeof source === "string") return <MathDisplay source={source}>{children}</MathDisplay>;
      return <div {...props}>{children}</div>;
    },
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      );
    },
  };
}

// Memoized: markdown parsing + highlighting is the most expensive render work
// in the app, so parent re-renders with identical props must be free.
export const MarkdownBody = memo(function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile, onNavigateLink, keepLineBreaks, keepTextLayout, artifacts }: MarkdownBodyProps) {
  const markdown = useStreamingMarkdownText(children, Boolean(isStreaming));
  const normalizedMarkdown = useMemo(
    () => normalizeDisplayMath(artifacts && markdown.includes(":::artifact") ? encodeArtifactsForMarkdown(markdown) : markdown),
    [markdown, artifacts],
  );
  const trackFences = !isStreaming && !!onOpenFile;
  const fenceFiles = useMemo(
    () => (trackFences ? fenceFilePaths(normalizedMarkdown, cwd) : NO_FENCE_FILES),
    [normalizedMarkdown, cwd, trackFences],
  );
  const components = useMemo(
    () => buildComponents(isStreaming, cwd, onOpenFile, fenceFiles, onNavigateLink),
    [isStreaming, cwd, onOpenFile, fenceFiles, onNavigateLink],
  );
  // Reuse the element when a new network delta has not published a snapshot.
  const body = useMemo(() => (
    <StreamingMarkdown
      isStreaming={isStreaming}
      remarkPlugins={keepTextLayout ? markdownTextLayoutRemarkPlugins : keepLineBreaks ? markdownUserRemarkPlugins : markdownRemarkPlugins}
      rehypePlugins={onNavigateLink ? markdownDocumentRehypePlugins : markdownRehypePlugins}
      urlTransform={onOpenFile ? markdownUrlTransform : onNavigateLink ? markdownAppUrlTransform : undefined}
      components={components}
    >
      {normalizedMarkdown}
    </StreamingMarkdown>
  ), [normalizedMarkdown, components, onOpenFile, onNavigateLink, keepLineBreaks, keepTextLayout, isStreaming]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      {body}
    </div>
  );
});
