"use client";

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import { parsePdfPageFragment, resolveLocalFileHref, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { markdownRehypePlugins, markdownRemarkPlugins, markdownUrlTransform, markdownUserRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { ImagePreview } from "./ImagePreview";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";
import { handleExternalLinkClick } from "@/lib/desktop-native";

const MarkdownLinkContext = createContext(false);

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** Render every line ending as a line break, for text the user typed. */
  keepLineBreaks?: boolean;
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

function buildComponents(
  isStreaming: boolean | undefined,
  cwd: string | undefined,
  onOpenFile: ((filePath: string, page?: number) => void) | undefined,
): Components {
  return {
    code({ className, children, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === "mermaid") {
          return (
            <MermaidBlock
              code={raw.replace(/\n$/, "")}
              isStreaming={isStreaming}
              defaultPreview
            />
          );
        }
        return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} isStreaming={isStreaming} />;
      }
      return (
        <code
          className="markdown-inline-code"
          {...props}
        >
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
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

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (!shouldOpenLocalFileInApp(event)) return;
        const target = event.currentTarget.getAttribute("target");
        if (target && target !== "_self") return;
        event.preventDefault();
        openFile(filePath, parsePdfPageFragment(href) ?? undefined);
      };

      return (
        <MarkdownLinkContext.Provider value={true}>
          <a href={href} {...props} onClick={handleClick}>
            {children}
          </a>
        </MarkdownLinkContext.Provider>
      );
    },
    img(props) {
      return <MarkdownImage cwd={cwd} {...props} />;
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

// A streaming bubble receives a new string on every text delta, and each one
// re-runs remark/rehype/KaTeX over the whole accumulated answer — quadratic in
// the answer's length. Parse at most once per interval while streaming; the
// final text renders as soon as streaming ends.
export const STREAMING_MARKDOWN_INTERVAL_MS = 120;

function useStreamingThrottle(value: string, active: boolean): string {
  const [shown, setShown] = useState(value);
  const lastShownAtRef = useRef(0);
  useEffect(() => {
    if (!active) return;
    const publish = () => {
      lastShownAtRef.current = Date.now();
      setShown(value);
    };
    const wait = lastShownAtRef.current + STREAMING_MARKDOWN_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      publish();
      return;
    }
    // Trailing edge: the latest text still lands once the interval elapses.
    const timer = setTimeout(publish, wait);
    return () => clearTimeout(timer);
  }, [value, active]);
  return active ? shown : value;
}

// Memoized: markdown parsing + highlighting is the most expensive render work
// in the app, so parent re-renders with identical props must be free.
export const MarkdownBody = memo(function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile, keepLineBreaks }: MarkdownBodyProps) {
  const markdown = useStreamingThrottle(children, Boolean(isStreaming));
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(markdown), [markdown]);
  const components = useMemo(
    () => buildComponents(isStreaming, cwd, onOpenFile),
    [isStreaming, cwd, onOpenFile],
  );
  // ReactMarkdown is not memoized itself; reusing the element lets the
  // throttled re-renders (text unchanged) skip parsing entirely.
  const body = useMemo(() => (
    <ReactMarkdown
      remarkPlugins={keepLineBreaks ? markdownUserRemarkPlugins : markdownRemarkPlugins}
      rehypePlugins={markdownRehypePlugins}
      urlTransform={onOpenFile ? markdownUrlTransform : undefined}
      components={components}
    >
      {normalizedMarkdown}
    </ReactMarkdown>
  ), [normalizedMarkdown, components, onOpenFile, keepLineBreaks]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      {body}
    </div>
  );
});
