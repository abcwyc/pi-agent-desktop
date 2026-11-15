"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useHtmlPreviewFrameMessages, useHtmlPreviewOptions } from "@/hooks/useHtmlPreviewFrame";
import { HTML_PREVIEW_SANDBOX, type HtmlPreviewKind } from "@/lib/html-preview";
import {
  HTML_PREVIEW_STREAM_INTERVAL_MS,
  HTML_PREVIEW_STREAM_MESSAGE,
  buildStreamShell,
} from "@/lib/html-preview-stream";

interface StreamingPreviewFrameProps {
  kind: Extract<HtmlPreviewKind, "html" | "svg">;
  /** The page text so far. */
  code: string;
  /** The page leaves its colours to the app (see htmlPreviewFollowsTheme), judged on the text so far. */
  themed: boolean;
  title: string;
  /** Shown in the frame until the first element is drawn. */
  label: string;
  className?: string;
  style?: CSSProperties;
  onSize?: (height: number) => void;
}

/**
 * A page drawn while it is still being written (lib/html-preview-stream.ts).
 * One frame for its whole life: the text is sent to it at most every
 * HTML_PREVIEW_STREAM_INTERVAL_MS and the frame patches what it shows, so
 * nothing reloads and no script of the page runs. The finished page is shown
 * by the normal preview, which replaces this one.
 */
export function StreamingPreviewFrame({ kind, code, themed, title, label, className, style, onSize }: StreamingPreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Theme changes reach a showing frame by message, so the options are read once.
  const options = useHtmlPreviewOptions("stream");
  const srcDoc = useMemo(() => buildStreamShell(kind, options, label), [kind, options, label]);
  // The document the frame last said it was ready for: a new shell is a new frame to wait for.
  const [readyDoc, setReadyDoc] = useState<string | null>(null);
  const ready = readyDoc === srcDoc;

  useHtmlPreviewFrameMessages(frameRef, {
    onSize,
    onReady: () => setReadyDoc(srcDoc),
  });

  const latestRef = useRef({ code, themed });
  latestRef.current = { code, themed };
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sentRef = useRef(false);
  useEffect(() => {
    if (!ready) return;
    // A send already waiting will carry the newest text.
    if (timerRef.current !== undefined) return;
    const send = () => {
      timerRef.current = undefined;
      sentRef.current = true;
      frameRef.current?.contentWindow?.postMessage({
        type: HTML_PREVIEW_STREAM_MESSAGE,
        html: latestRef.current.code,
        themed: latestRef.current.themed,
      }, "*");
    };
    if (sentRef.current) timerRef.current = setTimeout(send, HTML_PREVIEW_STREAM_INTERVAL_MS);
    else send();
  }, [ready, code, themed]);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  // A new shell has drawn nothing yet.
  useEffect(() => {
    sentRef.current = false;
  }, [srcDoc]);

  return (
    <iframe
      ref={frameRef}
      className={className}
      srcDoc={srcDoc}
      sandbox={HTML_PREVIEW_SANDBOX}
      title={title}
      style={style}
      aria-busy="true"
    />
  );
}
