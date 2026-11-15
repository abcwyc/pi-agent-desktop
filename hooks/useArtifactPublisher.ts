"use client";

import { useEffect, useMemo, useRef } from "react";
import { assistantTexts, collectArtifacts } from "@/lib/artifacts";
import { publishSessionArtifacts, setActiveArtifactSession, setArtifactFixHandler, setArtifactPromptHandler } from "@/lib/artifact-store";

type MessageLike = { role?: unknown; content?: unknown };

/**
 * Publishes the artifacts of the session ChatWindow shows, including the one
 * a streaming reply is writing, so the side panel can follow it live.
 */
export function useArtifactPublisher(
  sessionId: string | null | undefined,
  messages: readonly MessageLike[],
  streamingMessage: MessageLike | null | undefined,
  send?: (text: string) => void,
  /** Puts text in the composer without sending (a preview's `sendPrompt`). */
  insertPrompt?: (text: string) => void,
): void {
  // The transcript is scanned once per change; while a reply streams only its
  // own text is parsed again on each chunk.
  const finished = useMemo(() => collectArtifacts(assistantTexts(messages)), [messages]);
  const entries = useMemo(() => {
    const streamingTexts = streamingMessage ? assistantTexts([streamingMessage]) : [];
    if (!streamingTexts.length) return finished;
    // The finished reply can be in `messages` while the stream state still
    // holds it; counting both would add a phantom version.
    const last = messages.at(-1);
    if (streamingMessage === last) return finished;
    const lastTexts = last ? assistantTexts([last]) : [];
    if (lastTexts.length === streamingTexts.length && lastTexts.every((text, index) => text === streamingTexts[index])) {
      return finished;
    }
    return collectArtifacts(streamingTexts, finished);
  }, [finished, messages, streamingMessage]);

  useEffect(() => {
    setActiveArtifactSession(sessionId ?? null);
  }, [sessionId]);

  useEffect(() => () => setActiveArtifactSession(null), []);

  useEffect(() => {
    if (sessionId) publishSessionArtifacts(sessionId, entries);
  }, [sessionId, entries]);

  // "Fix" in a preview sends through the composer's normal path, which keeps
  // the text in the composer instead when a run is still busy.
  const sendRef = useRef(send);
  sendRef.current = send;
  const canSend = Boolean(send);
  useEffect(() => {
    if (!sessionId || !canSend) return;
    return setArtifactFixHandler(sessionId, (text) => sendRef.current?.(text));
  }, [sessionId, canSend]);

  const insertRef = useRef(insertPrompt);
  insertRef.current = insertPrompt;
  const canInsert = Boolean(insertPrompt);
  useEffect(() => {
    if (!sessionId || !canInsert) return;
    return setArtifactPromptHandler(sessionId, (text) => insertRef.current?.(text));
  }, [sessionId, canInsert]);
}
