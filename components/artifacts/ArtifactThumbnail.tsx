"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { useTheme } from "@/hooks/useTheme";
import { readThemeColors, readThemeKit } from "@/hooks/useHtmlPreviewFrame";
import type { ArtifactSummary, FileOutputSummary, OutputSummary } from "@/lib/artifact-index";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { buildHtmlPreviewDocument } from "@/lib/html-preview";
import { defaultThemeKit, themeKitSvgSource } from "@/lib/preview-theme-kit";
import { ArtifactTypeIcon } from "../ArtifactCard";
import { getFileIcon } from "../FileIcons";
import { renderMermaidSvg } from "../MermaidBlock";
import {
  PAGE_THUMBNAIL_HEIGHT,
  PAGE_THUMBNAIL_WIDTH,
  THUMBNAIL_MAX_CHARS,
  fileThumbnailKind,
  pageImageSvg,
  svgImageSource,
  textExcerpt,
  thumbnailKind,
} from "./artifacts-helpers";

// Thumbnails show the newest version of each row. Every one ends up as an
// <img> (or a text excerpt), never a live frame: a frame per row is a whole
// document to parse, lay out and paint, and dragging the scrollbar through a
// few hundred of them dropped frames. Images cannot run code, and HTML pages
// become an SVG <foreignObject> image, which also loads nothing external.
//
// The work (fetching the content, rendering Mermaid, rasterising) runs one job
// at a time and only while the list is not scrolling, and results are kept in
// memory, so a page reopened later paints its thumbnails at once.

const MAX_CACHED = 1000;
/** Scrolling counts as finished once no scroll event came for this long. */
const SCROLL_IDLE_MS = 150;
/** Rasterised size: the 64x48 box at 2x. */
const RASTER_WIDTH = 128;
const RASTER_HEIGHT = 96;

type Thumb = { kind: "image"; src: string; page: boolean } | { kind: "text"; text: string; code: boolean } | null;

const thumbCache = new Map<string, Thumb>();

function remember(key: string, value: Thumb): Thumb {
  thumbCache.delete(key);
  thumbCache.set(key, value);
  if (thumbCache.size > MAX_CACHED) thumbCache.delete(thumbCache.keys().next().value!);
  return value;
}

// --- Scroll tracking and visibility, shared by every row of a list ----------

let lastScrollAt = 0;
interface RootObserver {
  observer: IntersectionObserver;
  callbacks: Map<Element, (near: boolean) => void>;
}
const observers = new Map<Element | null, RootObserver>();
const onScroll = () => { lastScrollAt = performance.now(); };

function observe(root: HTMLElement | null, element: Element, callback: (near: boolean) => void): () => void {
  let entry = observers.get(root);
  if (!entry) {
    const callbacks = new Map<Element, (near: boolean) => void>();
    const observer = new IntersectionObserver((records) => {
      for (const record of records) callbacks.get(record.target)?.(record.isIntersecting);
    }, { root, rootMargin: "50% 0px" });
    entry = { observer, callbacks };
    observers.set(root, entry);
    (root ?? window).addEventListener("scroll", onScroll, { passive: true });
  }
  entry.callbacks.set(element, callback);
  entry.observer.observe(element);
  const current = entry;
  return () => {
    current.observer.unobserve(element);
    current.callbacks.delete(element);
    if (current.callbacks.size === 0) {
      current.observer.disconnect();
      (root ?? window).removeEventListener("scroll", onScroll);
      observers.delete(root);
    }
  };
}

function waitForScrollIdle(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const quiet = performance.now() - lastScrollAt;
      if (quiet >= SCROLL_IDLE_MS) resolve();
      else setTimeout(check, SCROLL_IDLE_MS - quiet);
    };
    check();
  });
}

// --- The job queue ---------------------------------------------------------

interface Job {
  key: string;
  /** False once the row has left the neighbourhood of the viewport. */
  wanted: () => boolean;
  run: () => Promise<Thumb>;
  done: Array<(value: Thumb) => void>;
}

const jobs = new Map<string, Job>();
let draining = false;

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (jobs.size) {
      await waitForScrollIdle();
      // Newest request first: that is what the user is looking at now.
      const job = [...jobs.values()].reverse().find((candidate) => candidate.wanted());
      if (!job) break;
      jobs.delete(job.key);
      let value: Thumb = null;
      try {
        value = await job.run();
        remember(job.key, value);
      } catch {
        // Not cached: a later visit tries again.
      }
      for (const resolve of job.done) resolve(value);
      // Give the frame back before the next job.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    draining = false;
  }
}

function request(key: string, wanted: () => boolean, run: () => Promise<Thumb>, done: (value: Thumb) => void): () => void {
  let job = jobs.get(key);
  if (!job) {
    job = { key, wanted, run, done: [] };
    jobs.set(key, job);
  } else {
    // Move to the end: most recent first.
    jobs.delete(key);
    jobs.set(key, job);
    job.wanted = wanted;
  }
  job.done.push(done);
  void drain();
  const current = job;
  return () => {
    current.done = current.done.filter((resolve) => resolve !== done);
    if (!current.done.length && jobs.get(key) === current) jobs.delete(key);
  };
}

// --- Rendering -------------------------------------------------------------

async function fetchLatestContent(item: ArtifactSummary): Promise<string | null> {
  const params = new URLSearchParams({ session: item.sessionId, identifier: item.identifier, latest: "1" });
  const response = await fetch(`/api/artifacts/item?${params}`, { cache: "no-store" });
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json() as { versions?: Array<{ content?: unknown }> };
  const content = data.versions?.at(-1)?.content;
  return typeof content === "string" && content.length <= THUMBNAIL_MAX_CHARS ? content : null;
}

/** The page as a static XHTML document: no scripts, frames or plugins. */
function pageSvg(html: string, isDark: boolean): string {
  // Read at render time: the theme class has landed by the time a job runs.
  const theme = readThemeColors(isDark);
  const doc = new DOMParser().parseFromString(buildHtmlPreviewDocument("html", html, { theme, themeKit: readThemeKit(isDark, theme) }), "text/html");
  for (const element of doc.querySelectorAll("script, noscript, iframe, frame, object, embed, link, base")) element.remove();
  return pageImageSvg(new XMLSerializer().serializeToString(doc.documentElement));
}

/**
 * Draws an SVG source to a small PNG once, so painting the row later is a
 * plain bitmap. WebKit refuses to export a canvas that drew a foreignObject
 * image; the SVG itself is still a fine thumbnail there.
 */
async function rasterise(src: string, width: number, height: number, fit: "contain" | "cover"): Promise<string> {
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = src;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = RASTER_WIDTH;
    canvas.height = RASTER_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) return src;
    const natural = { width: image.naturalWidth || width, height: image.naturalHeight || height };
    const scale = fit === "cover"
      ? Math.max(RASTER_WIDTH / natural.width, RASTER_HEIGHT / natural.height)
      : Math.min(RASTER_WIDTH / natural.width, RASTER_HEIGHT / natural.height);
    const drawWidth = natural.width * scale;
    const drawHeight = natural.height * scale;
    const x = fit === "cover" ? 0 : (RASTER_WIDTH - drawWidth) / 2;
    const y = fit === "cover" ? 0 : (RASTER_HEIGHT - drawHeight) / 2;
    context.drawImage(image, x, y, drawWidth, drawHeight);
    return canvas.toDataURL("image/png");
  } catch {
    return src;
  }
}

/** Mermaid keeps global configuration; the queue already runs one job at a time. */
/** A file through /api/files, which the session's own write/edit call authorizes. */
function fileApiUrl(item: FileOutputSummary): string {
  return `/api/files/${encodeFilePathForApi(item.path)}?${new URLSearchParams({ type: "read", sessionId: item.sessionId })}`;
}

async function fetchFileText(item: FileOutputSummary): Promise<string | null> {
  const response = await fetch(fileApiUrl(item), { cache: "no-store" });
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) return null;
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json() as { content?: unknown };
  return typeof data.content === "string" ? data.content.slice(0, THUMBNAIL_MAX_CHARS) : null;
}

type RenderKind = "image" | "mermaid" | "frame" | "text" | "code";

function rowKind(item: OutputSummary): RenderKind | "file-image" | "icon" {
  if (item.kind === "artifact") return thumbnailKind(item.type);
  return item.missing ? "icon" : fileThumbnailKind(item.path);
}

async function renderThumb(item: OutputSummary, isDark: boolean): Promise<Thumb> {
  const kind = rowKind(item);
  if (kind === "icon") return null;
  if (kind === "file-image") {
    // A photo can be large; drawn once into the small PNG, it is never decoded again.
    const src = fileApiUrl(item as FileOutputSummary);
    const vector = /\.svg$/i.test((item as FileOutputSummary).path);
    const raster = await rasterise(src, RASTER_WIDTH, RASTER_HEIGHT, vector ? "contain" : "cover");
    return raster === src ? null : { kind: "image", src: raster, page: !vector };
  }
  const source = item.kind === "artifact" ? await fetchLatestContent(item) : await fetchFileText(item);
  if (!source) return null;
  if (kind === "text" || kind === "code") {
    const textType = item.kind === "artifact" ? item.type : kind === "code" ? "code" : "markdown";
    return { kind: "text", text: textExcerpt(source, textType), code: textType === "code" };
  }
  if (kind === "frame") {
    const src = await rasterise(svgImageSource(pageSvg(source, isDark)), PAGE_THUMBNAIL_WIDTH, PAGE_THUMBNAIL_HEIGHT, "cover");
    return { kind: "image", src, page: true };
  }
  // A vector page that takes its colours from the theme kit has no page around it here: the kit goes inside the SVG.
  const svg = kind === "mermaid"
    ? await renderMermaidSvg(source, isDark).catch(() => null)
    : themeKitSvgSource(source, readThemeKit(isDark) ?? defaultThemeKit(isDark ? "dark" : "light"));
  if (!svg) return null;
  return { kind: "image", src: await rasterise(svgImageSource(svg), 300, 150, "contain"), page: false };
}

interface Props {
  item: OutputSummary;
  /** The scrolling list, so rows just below the fold load ahead of time. */
  scrollRoot: RefObject<HTMLElement | null>;
}

function itemKey(item: OutputSummary): string {
  const id = item.kind === "file" ? `file\u0000${item.path}\u0000${item.missing}` : `${item.sessionId}\u0000${item.identifier}`;
  return `${id}\u0000${item.versionCount}\u0000${item.updated}`;
}

type Tone = "web" | "doc" | "code" | "config" | "image" | "data";
const EXTENSION_TONES: Record<string, Tone> = {
  html: "web", htm: "web", css: "web", jsx: "web", tsx: "web", vue: "web", svelte: "web",
  md: "doc", mdx: "doc", txt: "doc", pdf: "doc", doc: "doc", docx: "doc", rtf: "doc",
  json: "config", yaml: "config", yml: "config", toml: "config", ini: "config", conf: "config", env: "config", plist: "config", xml: "config",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", ico: "image",
  csv: "data", tsv: "data", xlsx: "data", xls: "data", sql: "data", db: "data", parquet: "data",
};
const ARTIFACT_TONES: Record<string, Tone> = { html: "web", react: "web", svg: "image", mermaid: "image", markdown: "doc", code: "code" };

/** A hue family for the icon fallback, so a list of unrendered rows is not one grey column. */
function itemTone(item: OutputSummary): Tone {
  if (item.kind !== "file") return ARTIFACT_TONES[item.type] ?? "code";
  const ext = item.title.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!ext) return item.title.startsWith(".") ? "config" : "code";
  return EXTENSION_TONES[ext] ?? "code";
}

export function ArtifactThumbnail({ item, scrollRoot }: Props) {
  const kind = rowKind(item);
  const ref = useRef<HTMLSpanElement>(null);
  const { isDark } = useTheme();
  // Only Mermaid and pages that follow the app theme depend on it.
  const themed = kind === "mermaid" || kind === "frame";
  const key = `${itemKey(item)}${themed ? `\u0000${isDark ? "dark" : "light"}` : ""}`;
  // Read synchronously, so a cached thumbnail paints with the row instead of after it.
  const [thumb, setThumb] = useState<{ key: string; value: Thumb; fresh: boolean } | null>(() => (
    thumbCache.has(key) ? { key, value: thumbCache.get(key)!, fresh: false } : null
  ));
  const cached = thumbCache.has(key);
  const shown = thumb?.key === key ? thumb : cached ? { key, value: thumbCache.get(key)!, fresh: false } : null;

  useEffect(() => {
    const element = ref.current;
    if (kind === "icon" || cached || !element) return;
    // The row, not this box: rows may skip rendering their contents while off screen.
    const target = element.closest("li") ?? element;
    let near = false;
    let cancel: (() => void) | null = null;
    const stop = observe(scrollRoot.current, target, (next) => {
      near = next;
      if (near && !cancel) {
        cancel = request(key, () => near, () => renderThumb(item, isDark), (value) => {
          cancel = null;
          setThumb({ key, value, fresh: true });
        });
      }
    });
    return () => {
      stop();
      cancel?.();
    };
    // `item` and `isDark` are read for what `key` already covers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, key, cached, scrollRoot]);

  const value = shown?.value;
  const fresh = shown?.fresh ? " is-fresh" : "";
  let body = item.kind === "file" ? getFileIcon(item.title, 18) : <ArtifactTypeIcon type={item.type} size={18} />;
  if (value?.kind === "image") {
    // A data: URL; next/image has nothing to optimise.
    // eslint-disable-next-line @next/next/no-img-element
    body = <img className={`artifacts-thumb-image${value.page ? " is-page" : ""}${fresh}`} src={value.src} alt="" draggable={false} decoding="async" />;
  } else if (value?.kind === "text") {
    body = <span className={`artifacts-thumb-text${value.code ? " is-code" : ""}${fresh}`}>{value.text}</span>;
  }

  return (
    <span ref={ref} className={`artifacts-thumb${value ? " is-filled" : ""}`} data-tone={itemTone(item)} aria-hidden="true">
      {body}
    </span>
  );
}
