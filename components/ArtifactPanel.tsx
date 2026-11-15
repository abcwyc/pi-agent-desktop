"use client";

import { useI18n } from "@/hooks/useI18n";
import { requestArtifactFix, requestArtifactPrompt, useArtifactFixSessionId, useArtifactPromptSessionId, useSessionArtifact } from "@/lib/artifact-store";
import { ArtifactView } from "./ArtifactView";

interface ArtifactPanelProps {
  sessionId: string;
  identifier: string;
  title: string;
  /** A version picked from a message card; `nonce` makes repeat clicks count. */
  versionRequest?: { version?: number; nonce: number };
}

/**
 * One artifact of the open conversation in the right panel, read from the
 * chat's artifact store. "Ask to fix" is offered only while that conversation
 * is the one shown.
 */
export function ArtifactPanel({ sessionId, identifier, title, versionRequest }: ArtifactPanelProps) {
  const { t } = useI18n();
  const entry = useSessionArtifact(sessionId, identifier);
  const fixSessionId = useArtifactFixSessionId();
  const promptSessionId = useArtifactPromptSessionId();
  return (
    <ArtifactView
      identifier={identifier}
      title={title}
      versions={entry?.versions}
      versionRequest={versionRequest}
      onFix={fixSessionId === sessionId ? (text) => requestArtifactFix(sessionId, text) : undefined}
      onPrompt={promptSessionId === sessionId ? (text) => requestArtifactPrompt(sessionId, text) : undefined}
      emptyMessage={t("artifacts.unavailable", { title })}
    />
  );
}
