import { isValidLivenessHolder } from "./session-liveness";
import { describeStreamClient, type StreamClient } from "./stream-client";

/**
 * Open terminal and file-watch event streams with the page that opened them, for the Debug
 * panel's connected pages; an agent's own streams are listed by lib/agent-event-stream.ts. Each
 * takes a connection of the browser's HTTP/1.1 pool, so the panel counts them per page with the
 * agent's. Labels only, as there: nothing decides access by them. Server only.
 *
 * Route handlers are bundled into separate module graphs, each with its own copy of this module
 * (see lib/file-watch-registry.ts): Symbol.for + globalThis shares one registry.
 */

export type PageStreamKind = "terminal" | "file-watch";

export interface PageStreamLabel extends StreamClient {
  kind: PageStreamKind;
  /** The page id the stream was opened with (`?holder=`); null for an older page. */
  holder: string | null;
}

const PAGE_STREAM_REGISTRY: symbol = Symbol.for("pi-web:page-streams");

function pageStreams(): Set<PageStreamLabel> {
  const store = globalThis as Record<symbol, unknown>;
  const existing = store[PAGE_STREAM_REGISTRY];
  if (existing instanceof Set) return existing as Set<PageStreamLabel>;
  const created = new Set<PageStreamLabel>();
  store[PAGE_STREAM_REGISTRY] = created;
  return created;
}

/** The stream's page and client, from its request's `?holder=` and headers. */
export function pageStreamLabel(kind: PageStreamKind, request: Request): PageStreamLabel {
  const holder = new URL(request.url).searchParams.get("holder");
  return { kind, holder: isValidLivenessHolder(holder) ? holder : null, ...describeStreamClient(request.headers) };
}

/** Lists one open stream until the returned release runs; releasing again does nothing. */
export function registerPageStream(label: PageStreamLabel): () => void {
  const entry = { ...label };
  const streams = pageStreams();
  streams.add(entry);
  return () => {
    streams.delete(entry);
  };
}

export function listPageStreams(): PageStreamLabel[] {
  return [...pageStreams()].map((entry) => ({ ...entry }));
}
