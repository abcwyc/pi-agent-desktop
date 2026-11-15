"use client";

import { useSyncExternalStore } from "react";
import type { ArtifactEntry } from "./artifacts";

// Artifacts are derived from the transcript ChatWindow already holds, so the
// side panel (rendered by AppShell) and the message cards (deep inside
// MarkdownBody) read them from this module instead of threading props
// through every layer. ChatWindow publishes; nothing here is persisted.

export interface ArtifactOpenRequest {
  sessionId: string;
  identifier: string;
  title: string;
  /** 1-based version to show; omitted means the latest. */
  version?: number;
  /** Opened because a streamed artifact just finished, not by a click. */
  auto?: boolean;
  /**
   * Bring the panel forward. Automatic completions stage the tab without
   * stealing focus; user clicks reveal it.
   */
  reveal?: boolean;
}

const MAX_CACHED_SESSIONS = 20;
const sessions = new Map<string, Map<string, ArtifactEntry>>();
const listeners = new Set<() => void>();
let activeSessionId: string | null = null;
let opener: ((request: ArtifactOpenRequest) => void) | null = null;
let fixHandler: { sessionId: string; send: (text: string) => void } | null = null;
let promptHandler: { sessionId: string; insert: (text: string) => void } | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function sameEntry(a: ArtifactEntry, b: ArtifactEntry): boolean {
  if (a.versions.length !== b.versions.length) return false;
  return a.versions.every((version, index) => {
    const other = b.versions[index];
    return version.content === other.content
      && version.title === other.title
      && version.type === other.type
      && version.lang === other.lang
      && version.complete === other.complete;
  });
}

export function subscribeArtifacts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Replaces a session's artifacts. Unchanged entries keep their identity so
 * `useSessionArtifact` subscribers only re-render when their artifact moved.
 */
export function publishSessionArtifacts(sessionId: string, entries: readonly ArtifactEntry[]): void {
  const previous = sessions.get(sessionId);
  const next = new Map<string, ArtifactEntry>();
  let changed = !previous || previous.size !== entries.length;
  for (const entry of entries) {
    const old = previous?.get(entry.identifier);
    if (old && sameEntry(old, entry)) {
      next.set(entry.identifier, old);
    } else {
      next.set(entry.identifier, entry);
      changed = true;
    }
  }
  sessions.delete(sessionId);
  sessions.set(sessionId, next);
  while (sessions.size > MAX_CACHED_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined || oldest === activeSessionId) break;
    sessions.delete(oldest);
  }
  if (changed) emit();
}

export function setActiveArtifactSession(sessionId: string | null): void {
  if (activeSessionId === sessionId) return;
  activeSessionId = sessionId;
  emit();
}

export function getActiveArtifactSession(): string | null {
  return activeSessionId;
}

export function getSessionArtifact(sessionId: string | null | undefined, identifier: string): ArtifactEntry | undefined {
  return sessionId ? sessions.get(sessionId)?.get(identifier) : undefined;
}

export function useSessionArtifact(sessionId: string | null | undefined, identifier: string): ArtifactEntry | undefined {
  return useSyncExternalStore(
    subscribeArtifacts,
    () => getSessionArtifact(sessionId, identifier),
    () => undefined,
  );
}

/**
 * Re-renders only when the newest title of one of these artifacts changes, not
 * on every streamed chunk, so the shell can label its tabs without following
 * the whole store.
 */
export function useArtifactTitles(refs: readonly ArtifactRef[]): string {
  return useSyncExternalStore(subscribeArtifacts, () => artifactTitlesKey(refs), () => "");
}

type ArtifactRef = { sessionId: string; identifier: string };

/** The newest title of each artifact, as one comparable string. */
export function artifactTitlesKey(refs: readonly ArtifactRef[]): string {
  return refs.map((ref) => getSessionArtifact(ref.sessionId, ref.identifier)?.versions.at(-1)?.title ?? "").join("\u0000");
}

export function useActiveArtifactSession(): string | null {
  return useSyncExternalStore(subscribeArtifacts, getActiveArtifactSession, () => null);
}

/** AppShell registers the function that opens a panel tab; returns its cleanup. */
export function setArtifactOpener(handler: (request: ArtifactOpenRequest) => void): () => void {
  opener = handler;
  emit();
  return () => {
    if (opener === handler) {
      opener = null;
      emit();
    }
  };
}

export function hasArtifactOpener(): boolean {
  return opener !== null;
}

/**
 * Reactive: message cards render before AppShell's effect registers the
 * opener, and MarkdownBody is memoized, so a plain read could leave a card
 * stuck in its no-panel fallback.
 */
export function useHasArtifactOpener(): boolean {
  return useSyncExternalStore(subscribeArtifacts, hasArtifactOpener, () => false);
}

export function openArtifact(request: Omit<ArtifactOpenRequest, "sessionId">): boolean {
  if (!opener || !activeSessionId) return false;
  opener({ ...request, sessionId: activeSessionId });
  return true;
}

/**
 * ChatWindow registers how to send a message in the session it shows. A fix
 * request is only accepted for that session: an artifact tab left open from
 * another conversation must not post into the current one.
 */
export function setArtifactFixHandler(sessionId: string, send: (text: string) => void): () => void {
  const handler = { sessionId, send };
  fixHandler = handler;
  emit();
  return () => {
    if (fixHandler === handler) {
      fixHandler = null;
      emit();
    }
  };
}

export function getArtifactFixSessionId(): string | null {
  return fixHandler?.sessionId ?? null;
}

export function useArtifactFixSessionId(): string | null {
  return useSyncExternalStore(subscribeArtifacts, getArtifactFixSessionId, () => null);
}

export function requestArtifactFix(sessionId: string | null | undefined, text: string): boolean {
  if (!fixHandler || !sessionId || fixHandler.sessionId !== sessionId) return false;
  fixHandler.send(text);
  return true;
}

/**
 * ChatWindow registers how to put text in the composer of the session it
 * shows, for `sendPrompt` in a preview. Like a fix request it is accepted only
 * for that session, and unlike one it never sends: the text waits in the
 * composer for the user to read and send, because a preview's text can come
 * from anything the model read.
 */
export function setArtifactPromptHandler(sessionId: string, insert: (text: string) => void): () => void {
  const handler = { sessionId, insert };
  promptHandler = handler;
  emit();
  return () => {
    if (promptHandler === handler) {
      promptHandler = null;
      emit();
    }
  };
}

export function getArtifactPromptSessionId(): string | null {
  return promptHandler?.sessionId ?? null;
}

export function useArtifactPromptSessionId(): string | null {
  return useSyncExternalStore(subscribeArtifacts, getArtifactPromptSessionId, () => null);
}

export function requestArtifactPrompt(sessionId: string | null | undefined, text: string): boolean {
  if (!promptHandler || !sessionId || promptHandler.sessionId !== sessionId) return false;
  promptHandler.insert(text);
  return true;
}

/** Test hook: forget every published session and handler. */
export function resetArtifactStore(): void {
  sessions.clear();
  activeSessionId = null;
  opener = null;
  fixHandler = null;
  promptHandler = null;
  emit();
}
