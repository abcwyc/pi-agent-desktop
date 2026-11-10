"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { ChatWindow } from "./ChatWindow";
import type { ChatInputHandle } from "./ChatInput";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo } from "@/lib/types";

type ChatProps = ComponentProps<typeof ChatWindow>;

interface Props extends Pick<ChatProps, "modelsRefreshKey" | "onOpenFile" | "onOpenSession" | "onAgentEnd" | "initialPrompt" | "onInitialPromptConsumed" | "soundEnabled" | "playDoneSound" | "unlockAudio" | "quoteSelectionEnabled" | "onSessionForked" | "onOpenSettings"> {
  sessionId: string;
  running: boolean;
}

const RETRY_MS = 1000;

/**
 * A side chat's right-panel tab (C1, upstream ADR 0007): the chat, scoped to
 * that session. It is never the page's main chat: no URL, no sidebar row, and
 * the page's global shortcuts stay with the main chat. Info is fetched here
 * because a tab opens by id, and again while a run just started has no file
 * to read yet.
 */
export function SessionChatPanel({ sessionId, running, ...chatProps }: Props) {
  const { t } = useI18n();
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [state, setState] = useState<"loading" | "missing" | "error">("loading");
  // Edit from here, dropped files and a failed send's text all reach the composer through this.
  const chatInputRef = useRef<ChatInputHandle | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { signal: controller.signal, cache: "no-store" });
        if (res.status === 404) {
          setState("missing");
          if (running) retry = setTimeout(() => void load(), RETRY_MS);
          return;
        }
        const data = await res.json() as { info?: SessionInfo };
        if (data.info) setInfo(data.info);
        else setState("error");
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) setState("error");
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [sessionId, running]);

  if (info) {
    return (
      <ChatWindow
        {...chatProps}
        session={info}
        sessionRunning={running}
        newSessionCwd={null}
        newSessionDraftKey={null}
        chatInputRef={chatInputRef}
        conversationNavigatorEnabled={false}
        panel
      />
    );
  }
  return (
    <div role={state === "error" ? "alert" : undefined} className="session-chat-panel-status">
      {t(state === "loading" || running ? "sessionPanel.loading" : state === "missing" ? "sessionPanel.missing" : "sessionPanel.error")}
    </div>
  );
}
