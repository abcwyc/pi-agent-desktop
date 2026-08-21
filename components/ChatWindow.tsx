"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, CustomMessage, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolResultMessage, UserMessage } from "@/lib/types";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { countToolCallBlocks, getDisplayableAssistantBlocks, splitFinalAssistantBlocks } from "@/lib/message-display";
import { MessageView } from "./MessageView";
import { ConversationNavigator, type ConversationTurnLocation } from "./ConversationNavigator";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { useI18n } from "@/hooks/useI18n";
import { useAgentSession, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { useDragDrop } from "@/hooks/useDragDrop";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { PRODUCT_NAME } from "@/lib/branding";
import { importDroppedProjectFiles, partitionChatDroppedFiles } from "@/lib/chat-file-drop";
import {
  captureScrollDistance,
  getNextVisibleCount,
  getVisibleRenderWindow,
  restoreScrollTop,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";
import { sessionVisibleCounts } from "@/lib/scroll-memory";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string) => void;
  /** Fired after non-image drops are copied into the session cwd (so the explorer can refresh). */
  onProjectFilesImported?: () => void;
}

function phaseLabel(phase: AgentPhase, t: (key: string, params?: Record<string, string | number>) => string): string | null {
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return t("chat.runningTool");
    if (names.length === 1) return t("chat.runningNamedTool", { name: names[0] });
    if (names.length <= 3) return t("chat.runningTools", { names: names.join(", ") });
    return t("chat.runningToolsMore", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  }
  if (phase?.kind === "waiting_model") return t("chat.waitingModel");
  if (phase?.kind === "running_command") return t("chat.runningCommand");
  return null;
}

const CHAT_COLUMN_PADDING = 16;

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return getFinalSplit(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function getAssistantPreviewText(message: AgentMessage): string | null {
  if (message.role !== "assistant") return null;
  const text = getFinalSplit(message as AssistantMessage).answerBlocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function countToolCalls(messages: AgentMessage[], indices: number[]): number {
  let count = 0;
  for (const idx of indices) {
    const msg = messages[idx];
    if (msg?.role !== "assistant") continue;
    count += countToolCallBlocks(getDisplayableAssistantBlocks(msg as AssistantMessage));
  }
  return count;
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  }
  return message.role === "custom";
}

// A user message normally anchors a turn (user prompt → process → final
// answer), and the process messages in between get folded into a collapsed
// ProcessDetailsGroup. When compaction fires mid-turn, pi drops the original
// user prompt and inserts a compaction summary (role "custom", customType
// "compaction") in its place; the agent then keeps producing tool calls and a
// final answer with no user message left to anchor them. Treat a compaction
// summary as an anchor too, otherwise every post-compaction message renders
// standalone and never collapses.
function isGroupAnchor(message: AgentMessage): boolean {
  if (message.role === "user") return true;
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

interface FinalSplitEntry {
  processBlocks: AssistantContentBlock[];
  answerBlocks: AssistantContentBlock[];
  processMessage: AssistantMessage | null;
  answerMessage: AssistantMessage | null;
}

// Message objects are immutable (any change produces a new object), so the
// split/derived messages can be cached per object. Without this, every render
// hands MessageView freshly-created message objects, defeating its memo and
// re-running markdown + highlighting for already-finished answers on each
// streaming delta.
const finalSplitCache = new WeakMap<AssistantMessage, FinalSplitEntry>();

function getFinalSplit(message: AssistantMessage): FinalSplitEntry {
  let cached = finalSplitCache.get(message);
  if (!cached) {
    const { processBlocks, answerBlocks } = splitFinalAssistantBlocks(message);
    cached = {
      processBlocks,
      answerBlocks,
      processMessage: processBlocks.length > 0
        ? withAssistantBlocks(message, processBlocks, { omitUsage: true })
        : null,
      answerMessage: answerBlocks.length > 0
        ? withAssistantBlocks(message, answerBlocks)
        : null,
    };
    finalSplitCache.set(message, cached);
  }
  return cached;
}

function ProcessDetailsGroup({ messageCount, toolCallCount, children, t }: { messageCount: number; toolCallCount: number; children: ReactNode; t: (key: string, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(false);
  const parts = [t("chat.processDetails"), `${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`];
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);

  return (
    <div className="process-details" style={{ marginBottom: 14 }}>
      <button
        className="process-details-trigger"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={expanded ? t("chat.collapseProcess") : t("chat.expandProcess")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </button>
      {expanded && (
        <div className="process-details-content" style={{ marginTop: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function ChatWindow({ session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsChange, onSessionStatsPanelOpen, onContextUsageChange, onOpenFile, onProjectFilesImported }: Props) {
  const { t } = useI18n();
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio } = useAudio();

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const soundedExtensionDialogIdRef = useRef<string | null>(null);
  const wrappedOnAgentEnd = useCallback(() => {
    if (soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.();
  }, [onAgentEnd]);

  // 稳定化 onEditContent 引用，配合 React.memo 防止历史消息重渲染
  const handleEditContent = useCallback((message: UserMessage) => {
    chatInputRef?.current?.replaceMessage(message);
  }, [chatInputRef]);

  const {
    loading, error, messages, entryIds, streamState,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection,
    agentPhase,
    addNotice,
    isNew,
    sessionIdRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, promptAnchorActive,
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand, retryLoad,
    handleToolPresetChange, handleThinkingLevelChange, loadSlashCommands, scrollToBottom, scrollUserMsgToTop,
  } = useAgentSession({
    session, newSessionCwd, onAgentEnd: wrappedOnAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  });
  const sessionBusy = agentRunning || bashRunning;

  const conversationTurns = useMemo<ConversationTurnLocation[]>(() => {
    const turns: ConversationTurnLocation[] = [];
    for (let userIdx = 0; userIdx < messages.length; userIdx++) {
      const question = getUserInputText(messages[userIdx]);
      if (!question) continue;
      let answer: string | null = null;
      for (let idx = userIdx + 1; idx < messages.length && messages[idx].role !== "user"; idx++) {
        answer = getAssistantPreviewText(messages[idx]) ?? answer;
      }
      turns.push({ index: turns.length, question, answer });
    }
    return turns;
  }, [messages]);

  // Fork/navigate stay referentially stable across busy transitions; gating
  // happens at call time (ref) and visually via the data-session-busy CSS
  // hook. Toggling these props between undefined and a function would defeat
  // every MessageView memo twice per agent turn.
  const sessionBusyRef = useRef(sessionBusy);
  sessionBusyRef.current = sessionBusy;
  const stableHandleFork = useCallback((entryId: string) => {
    if (sessionBusyRef.current) return;
    handleFork(entryId);
  }, [handleFork]);
  const stableHandleNavigate = useCallback((entryId: string) => {
    if (sessionBusyRef.current) return;
    handleNavigate(entryId);
  }, [handleNavigate]);

  useEffect(() => {
    if (!extensionDialog || soundedExtensionDialogIdRef.current === extensionDialog.id) return;
    soundedExtensionDialogIdRef.current = extensionDialog.id;
    playDoneSoundRef.current();
  }, [extensionDialog]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
  }, [sessionBusy, handleAbort]);

  // --- Lazy-load historical messages ---
  // Only render the last N messages initially. When the user scrolls to the
  // top, load another page while keeping the scroll position stable.
  const lazyLoadSessionKey = session?.id ?? newSessionCwd ?? null;
  const [visibleCount, setVisibleCount] = useState(
    () => (lazyLoadSessionKey != null ? sessionVisibleCounts.get(lazyLoadSessionKey) : undefined) ?? VISIBLE_PAGE_SIZE,
  );
  const sentinelRef = useRef<HTMLDivElement>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);

  const selectConversationTurn = useCallback((turnIndex: number) => {
    setVisibleCount(messages.length);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      const anchor = container?.querySelector<HTMLElement>(`[data-conversation-turn="${turnIndex}"]`);
      if (!container || !anchor) return;
      const top = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 16;
      container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }));
  }, [messages.length, scrollContainerRef]);

  // Reset the lazy-load window when switching sessions, otherwise the page
  // count grown in a long session carries over and the next session mounts
  // with far more messages rendered than intended. The grown count is saved
  // per session: the scrollTop remembered for a session is a pixel offset
  // into the window that was rendered at the time, so restoring it against a
  // freshly reset 1-page window would land on the wrong message.
  const prevLazyLoadKeyRef = useRef(lazyLoadSessionKey);
  useEffect(() => {
    if (prevLazyLoadKeyRef.current === lazyLoadSessionKey) return;
    const prevKey = prevLazyLoadKeyRef.current;
    prevLazyLoadKeyRef.current = lazyLoadSessionKey;
    if (prevKey != null) {
      if (visibleCount > VISIBLE_PAGE_SIZE) sessionVisibleCounts.set(prevKey, visibleCount);
      else sessionVisibleCounts.delete(prevKey);
    }
    setVisibleCount((lazyLoadSessionKey != null ? sessionVisibleCounts.get(lazyLoadSessionKey) : undefined) ?? VISIBLE_PAGE_SIZE);
  }, [lazyLoadSessionKey, visibleCount]);

  // Save on unmount too (new-chat key bumps remount ChatWindow); the cache is
  // module-level so it outlives this instance.
  const visibleCountRef = useRef(visibleCount);
  visibleCountRef.current = visibleCount;
  useEffect(() => () => {
    const key = prevLazyLoadKeyRef.current;
    if (key != null && visibleCountRef.current > VISIBLE_PAGE_SIZE) {
      sessionVisibleCounts.set(key, visibleCountRef.current);
    }
  }, []);

  // IntersectionObserver on the sentinel div at the top of the message list.
  // When it becomes visible, load the next page of older messages.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          // Save distance from top before prepending to restore scroll later
          prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
          setVisibleCount((prev) => getNextVisibleCount(prev));
        }
      },
      { root: container, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, messages.length, scrollContainerRef]);

  // After visibleCount increases (more messages prepended), restore the
  // scroll position so the viewport doesn't jump.
  useEffect(() => {
    if (prevScrollDistanceRef.current == null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = restoreScrollTop(container.scrollHeight, prevScrollDistanceRef.current);
    prevScrollDistanceRef.current = null;
  }, [visibleCount, scrollContainerRef]);
  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  const cwd = session?.cwd ?? newSessionCwd;
  const projectImportBusyRef = useRef(false);

  const onDrop = useCallback((files: File[]) => {
    const { images, projectFiles } = partitionChatDroppedFiles(files);

    // Images stay on the multimodal attachment path (blocked while the agent is busy).
    if (images.length > 0 && !sessionBusy) {
      chatInputRef?.current?.addImages(images);
    }

    // Documents/other files are copied into the project root and @mentioned so
    // the agent can read them with its normal tools — not inlined into the prompt.
    if (projectFiles.length === 0) return;
    if (!cwd) {
      addNotice({ type: "error", message: t("chat.dropNeedsProject") });
      return;
    }
    if (projectImportBusyRef.current) return;
    projectImportBusyRef.current = true;

    void (async () => {
      try {
        const result = await importDroppedProjectFiles(cwd, projectFiles);
        if (result.mentionText) {
          chatInputRef?.current?.insertText(result.mentionText);
          chatInputRef?.current?.focus();
        }
        if (result.uploaded.length > 0) onProjectFilesImported?.();

        const failureParts = [
          ...result.errors.map((item) => `${item.name}: ${item.error}`),
          ...result.rejected.map((item) => `${item.name}: ${item.reason}`),
        ];
        if (failureParts.length > 0) {
          addNotice({
            type: result.mentionText ? "warning" : "error",
            message: t("chat.dropProjectPartialFailure", { detail: failureParts.slice(0, 3).join("; ") }),
          });
        } else if (result.uploaded.length > 0 || result.skipped.length > 0) {
          addNotice({
            type: "success",
            message: t("chat.dropProjectSuccess", {
              count: result.uploaded.length + result.skipped.length,
            }),
          });
        }
      } catch (error) {
        addNotice({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        projectImportBusyRef.current = false;
      }
    })();
  }, [addNotice, chatInputRef, cwd, onProjectFilesImported, sessionBusy, t]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);

  const isEmptyNew = isNew && !loading && !error && messages.length === 0 && !streamState.isStreaming && !sessionBusy;
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;
  const bottomComposerRef = useRef<HTMLDivElement | null>(null);
  const [bottomComposerHeight, setBottomComposerHeight] = useState(0);
  const bottomComposerHeightRef = useRef(0);
  const bottomComposerScrollFrameRef = useRef<number | null>(null);
  const [promptAnchorSpacerHeight, setPromptAnchorSpacerHeight] = useState(0);
  const promptAnchorSpacerHeightRef = useRef(0);
  const promptAnchorScrollPendingRef = useRef(false);

  useLayoutEffect(() => {
    const composer = bottomComposerRef.current;
    if (!composer) {
      bottomComposerHeightRef.current = 0;
      setBottomComposerHeight(0);
      return;
    }

    const updateBottomComposerHeight = () => {
      const nextHeight = Math.ceil(composer.getBoundingClientRect().height);
      if (bottomComposerHeightRef.current === nextHeight) return;

      const previousHeight = bottomComposerHeightRef.current;
      bottomComposerHeightRef.current = nextHeight;
      setBottomComposerHeight(nextHeight);

      if (bottomComposerScrollFrameRef.current !== null) {
        cancelAnimationFrame(bottomComposerScrollFrameRef.current);
      }
      bottomComposerScrollFrameRef.current = requestAnimationFrame(() => {
        bottomComposerScrollFrameRef.current = null;
        const currentContainer = scrollContainerRef.current;
        const distanceFromBottom = currentContainer
          ? currentContainer.scrollHeight - currentContainer.clientHeight - currentContainer.scrollTop
          : Number.POSITIVE_INFINITY;
        // Preserve a tail-pinned view while avoiding a jump for history readers.
        if (distanceFromBottom <= Math.abs(nextHeight - previousHeight) + 1) {
          scrollToBottom("auto");
        }
      });
    };
    updateBottomComposerHeight();

    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updateBottomComposerHeight);
    observer?.observe(composer);
    return () => {
      observer?.disconnect();
      if (bottomComposerScrollFrameRef.current !== null) {
        cancelAnimationFrame(bottomComposerScrollFrameRef.current);
        bottomComposerScrollFrameRef.current = null;
      }
    };
  }, [error, isEmptyNew, loading, scrollContainerRef, scrollToBottom]);

  useLayoutEffect(() => {
    if (!agentRunning || !promptAnchorActive) {
      promptAnchorScrollPendingRef.current = false;
      if (promptAnchorSpacerHeightRef.current !== 0) {
        promptAnchorSpacerHeightRef.current = 0;
        setPromptAnchorSpacerHeight(0);
      }
      return;
    }

    const container = scrollContainerRef.current;
    const userMessage = lastUserMsgRef.current;
    if (!container || !userMessage) return;

    const updatePromptAnchorSpacer = () => {
      const userMessageTop = userMessage.getBoundingClientRect().top
        - container.getBoundingClientRect().top
        + container.scrollTop;
      const targetTop = Math.max(0, userMessageTop - 16);
      // Exclude the current spacer so each measurement converges instead of
      // alternating between adding it and removing it.
      const maxScrollTopWithoutAnchor = Math.max(
        0,
        container.scrollHeight - promptAnchorSpacerHeightRef.current - container.clientHeight,
      );
      const nextPromptAnchorSpacerHeight = Math.max(
        0,
        Math.ceil(targetTop - maxScrollTopWithoutAnchor),
      );

      if (nextPromptAnchorSpacerHeight !== promptAnchorSpacerHeightRef.current) {
        const needsInitialScroll = promptAnchorSpacerHeightRef.current === 0
          && nextPromptAnchorSpacerHeight > 0;
        promptAnchorSpacerHeightRef.current = nextPromptAnchorSpacerHeight;
        promptAnchorScrollPendingRef.current ||= needsInitialScroll;
        setPromptAnchorSpacerHeight(nextPromptAnchorSpacerHeight);
        return;
      }

      if (promptAnchorScrollPendingRef.current) {
        promptAnchorScrollPendingRef.current = false;
        scrollUserMsgToTop();
      }
    };

    updatePromptAnchorSpacer();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updatePromptAnchorSpacer);
    observer?.observe(container);
    observer?.observe(userMessage);
    return () => observer?.disconnect();
  }, [
    agentRunning,
    bottomComposerHeight,
    lastUserMsgRef,
    messages.length,
    promptAnchorActive,
    promptAnchorSpacerHeight,
    scrollContainerRef,
    scrollUserMsgToTop,
    streamState.streamingMessage,
  ]);

  // Group messages into turns (user prompt → collapsed process → final
  // answer) once per relevant change, not on every render. Streaming deltas
  // only touch streamState.streamingMessage, which is intentionally NOT a
  // dependency here — the live bubble renders separately below.
  const sessionIdForViews = session?.id ?? null;
  const streamActive = streamState.isStreaming;
  const renderedMessages = useMemo(() => {
    const toolResultsMap = new Map<string, ToolResultMessage>();
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        toolResultsMap.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
      }
    }

    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") { lastUserIdx = i; break; }
    }
    // Anchor for live-tail detection: the last user message, or a
    // compaction summary when compaction has replaced it mid-turn.
    // Computed independently from lastUserIdx (which is kept for the
    // scroll-to-user ref) because a compaction summary can sit after
    // the last user message and anchor the still-streaming segment.
    let lastAnchorIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isGroupAnchor(messages[i])) { lastAnchorIdx = i; break; }
    }

    const turnIndexByMessageIndex = new Map<number, number>();
    let nextTurnIndex = 0;
    for (let messageIdx = 0; messageIdx < messages.length; messageIdx++) {
      if (messages[messageIdx].role === "user" && getUserInputText(messages[messageIdx])) {
        turnIndexByMessageIndex.set(messageIdx, nextTurnIndex++);
      }
    }

    const renderMessage = (idx: number, options: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean } = {}): ReactNode => {
      const msg = options.messageOverride ?? messages[idx];
      const prevAssistantEntryId =
        msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
          ? entryIds[idx - 1]
          : undefined;
      const isVisible = msg.role === "user" || msg.role === "assistant";
      const keyPrefix = options.keyPrefix ?? "message";
      let showTimestamp = false;
      if (msg.role === "assistant") {
        showTimestamp = true;
        for (let j = idx + 1; j < messages.length; j++) {
          const r = messages[j].role;
          if (r === "user") break;
          if (r === "assistant") { showTimestamp = false; break; }
        }
        // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
        if (showTimestamp && streamActive && idx === messages.length - 1) {
          showTimestamp = false;
        }
      }
      if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
      const view = (
        <MessageView
          key={`${keyPrefix}-view-${idx}`}
          message={msg}
          toolResults={toolResultsMap}
          modelNames={modelNames}
          cwd={messageCwd}
          onOpenFile={onOpenFile}
          entryId={entryIds[idx]}
          onFork={isNew || (idx === 0 && msg.role === "user") ? undefined : stableHandleFork}
          forking={forkingEntryId === entryIds[idx]}
          onNavigate={stableHandleNavigate}
          prevAssistantEntryId={prevAssistantEntryId}
          onEditContent={handleEditContent}
          showTimestamp={showTimestamp}
          prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
          sessionId={sessionIdForViews ?? sessionIdRef.current ?? undefined}
        />
      );
      if (!isVisible || options.attachRef === false) return view;
      if (idx !== lastUserIdx) {
        return (
          <div key={`${keyPrefix}-${idx}`} data-conversation-turn={turnIndexByMessageIndex.get(idx)}>
            {view}
          </div>
        );
      }
      return (
        <div
          key={`${keyPrefix}-${idx}`}
          data-conversation-turn={turnIndexByMessageIndex.get(idx)}
          ref={(el) => {
            (lastUserMsgRef as { current: HTMLDivElement | null }).current = el;
          }}
        >
          {view}
        </div>
      );
    };

    const rendered: ReactNode[] = [];
    for (let idx = 0; idx < messages.length;) {
      const msg = messages[idx];
      if (!isGroupAnchor(msg)) {
        rendered.push(renderMessage(idx));
        idx += 1;
        continue;
      }

      const userIdx = idx;
      let endIdx = userIdx + 1;
      while (endIdx < messages.length && !isGroupAnchor(messages[endIdx])) endIdx += 1;

      const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);

      if (finalAssistantIdx === -1) {
        for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
          rendered.push(renderMessage(renderIdx));
        }
        idx = endIdx;
        continue;
      }

      const isLiveTail = (sessionBusy || streamActive) && endIdx === messages.length && userIdx === lastAnchorIdx;
      if (isLiveTail) {
        for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
          rendered.push(renderMessage(renderIdx));
        }
        idx = endIdx;
        continue;
      }

      rendered.push(renderMessage(userIdx));

      const processIndices: number[] = [];
      for (let processIdx = userIdx + 1; processIdx < finalAssistantIdx; processIdx++) {
        processIndices.push(processIdx);
      }
      const visibleProcessIndices = processIndices.filter((processIdx) => hasDisplayableProcessMessage(messages[processIdx]));
      const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
      const finalSplit = getFinalSplit(finalAssistant);
      const finalProcessMessage = finalSplit.processMessage;
      const finalAnswerMessage = finalSplit.answerMessage;

      const processCount = visibleProcessIndices.length + (finalProcessMessage ? 1 : 0);
      if (processCount > 0) {
        rendered.push(
          <ProcessDetailsGroup
            key={`process-group-${userIdx}-${finalAssistantIdx}`}
            messageCount={processCount}
            t={t}
            toolCallCount={countToolCalls(messages, visibleProcessIndices) + countToolCallBlocks(finalSplit.processBlocks)}
          >
            {visibleProcessIndices.map((processIdx) => renderMessage(processIdx, { attachRef: false, keyPrefix: "process" }))}
            {finalProcessMessage && renderMessage(finalAssistantIdx, { attachRef: false, keyPrefix: "process-final", messageOverride: finalProcessMessage, showTimestamp: false })}
          </ProcessDetailsGroup>,
        );
      }

      if (finalAnswerMessage) {
        rendered.push(renderMessage(finalAssistantIdx, { messageOverride: finalAnswerMessage }));
      }
      for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
        rendered.push(renderMessage(renderIdx));
      }
      idx = endIdx;
    }
    const { startIndex, hasMore } = getVisibleRenderWindow(rendered.length, visibleCount);
    return (
      <>
        {hasMore && (
          <div ref={sentinelRef} className="py-3 text-center text-xs text-text-muted">
            {t("chat.loadEarlier", { count: startIndex })}
          </div>
        )}
        {rendered.slice(startIndex)}
      </>
    );
  }, [
    messages, entryIds, streamActive, sessionBusy, isNew, forkingEntryId,
    modelNames, messageCwd, onOpenFile, handleEditContent,
    stableHandleFork, stableHandleNavigate, sessionIdForViews,
    visibleCount, t, lastUserMsgRef, sessionIdRef,
  ]);

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={modelError}
      modelScopeWarnings={modelScopeWarnings}
      onModelChange={handleModelChange}
      onCompact={session || isNew ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      toolPreset={toolPreset}
      onToolPresetChange={session || isNew ? handleToolPresetChange : undefined}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      inputHistory={inputHistory}
      onRecallQueue={handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : undefined)}
      cwd={session?.cwd ?? newSessionCwd}
      autoFocus={isNew}
      extensionStatuses={extensionStatuses}
      contextUsage={contextUsage}
      onSessionStatsPanelOpen={onSessionStatsPanelOpen}
    />
  );

  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor");
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor");

  return (
    <div
      className="chat-window relative flex h-full min-w-0 flex-col overflow-hidden"
      data-session-busy={sessionBusy ? "true" : undefined}
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[var(--accent-soft)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[var(--accent-border)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          {/* Neutral gray constants: SVG presentation attributes can't resolve
              CSS vars, and this gray reads fine on both light and dark. */}
          <div className="relative z-[1] flex flex-col items-center gap-3 px-6 text-center">
            <svg
              width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
              className="drop-shadow-[0_6px_18px_var(--focus-ring)]"
            >
              <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(120,120,128,0.10)" stroke="rgba(120,120,128,0.55)" strokeWidth="1.8"/>
              <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(120,120,128,0.18)" stroke="rgba(120,120,128,0.45)" strokeWidth="1.4" strokeLinejoin="round"/>
              <circle cx="96" cy="58" r="8" fill="rgba(120,120,128,0.24)" stroke="rgba(120,120,128,0.60)" strokeWidth="1.6"/>
              <g stroke="rgba(120,120,128,0.50)" strokeWidth="1.4" strokeLinecap="round">
                <line x1="96" y1="46" x2="96" y2="43"/>
                <line x1="96" y1="70" x2="96" y2="73"/>
                <line x1="84" y1="58" x2="81" y2="58"/>
                <line x1="108" y1="58" x2="111" y2="58"/>
                <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
                <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
                <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
                <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
              </g>
            </svg>
            <div style={{ maxWidth: 320, color: "var(--text)", fontSize: 13, fontWeight: 550, lineHeight: 1.35 }}>
              {t("chat.dropFilesHint")}
            </div>
            <div style={{ maxWidth: 360, color: "var(--text-muted)", fontSize: 11.5, lineHeight: 1.4 }}>
              {t("chat.dropFilesDetail")}
            </div>
          </div>
        </div>
      )}

      {extensionDialog && (
        <ExtensionDialog
          request={extensionDialog}
          onRespond={respondToExtensionUi}
        />
      )}

      {extensionCustomUi && (
        <ExtensionCustomPanel
          request={extensionCustomUi}
          onInput={sendExtensionCustomInput}
        />
      )}

      {isEmptyNew ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className="chat-empty-state w-full max-w-[820px]">
            <div
              className="chat-empty-brand mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-start",
                marginLeft: 16,
                marginRight: 16,
              }}
            >
              <div className="chat-empty-brand-copy">
                <strong>{t("chat.emptyTitle")}</strong>
                <span>{t("chat.emptySubtitle", { product: PRODUCT_NAME })}</span>
              </div>
            </div>
            <NoticeShelf notices={notices} align="right" />
            {chatInputElement}
          </div>
        </div>
      ) : (
      <>
      {/* Composer overlays the scrollport; trailing spacer clears the last lines. */}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="relative flex min-w-0 flex-1 overflow-hidden">
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 0,
            right: 0,
            zIndex: 40,
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            pointerEvents: "none",
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <NoticeShelf notices={notices} floating align="right" />
          </div>
        </div>
        <div
          ref={scrollContainerRef}
          className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4"
          style={{ scrollbarGutter: "stable both-edges" }}
        >
          <div style={{ minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div style={{ width: "100%", minWidth: 0, maxWidth: 820, margin: "0 auto" }}>
              {loading || error ? (
                <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 px-6 text-center">
                  {loading ? (
                    <div className="text-text-muted">{t("chat.loadingSession")}</div>
                  ) : (
                    <>
                      <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 600 }}>
                        {t("chat.loadFailed")}
                      </div>
                      <div style={{ color: "var(--text-dim)", fontSize: 12, lineHeight: 1.45, maxWidth: 480, overflowWrap: "anywhere" }}>
                        {error}
                      </div>
                      <button
                        type="button"
                        onClick={retryLoad}
                        style={{
                          marginTop: 6, height: 28, padding: "0 14px",
                          border: "1px solid var(--separator)", borderRadius: 7,
                          background: "var(--surface)", color: "var(--text)",
                          fontSize: 12.5, fontWeight: 550, cursor: "pointer",
                        }}
                      >
                        {t("common.retry")}
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <>
              <ExtensionWidgets widgets={aboveEditorWidgets} />

            {renderedMessages}
            {streamState.isStreaming && streamState.streamingMessage && (
              <MessageView message={streamState.streamingMessage as AgentMessage} isStreaming modelNames={modelNames} cwd={messageCwd} onOpenFile={onOpenFile} />
            )}

            {agentRunning && !streamState.streamingMessage && agentPhase && (
              <div className="py-2 text-[13px] text-text-muted">
                <span className="animate-[pulse_1.5s_infinite]">{phaseLabel(agentPhase, t)}</span>
              </div>
            )}

            {bashRunning && !pendingBash && (
              <div className="py-2 text-[13px] text-text-muted">
                 <span className="animate-[pulse_1.5s_infinite]">{t("chat.runningCommand")}</span>
              </div>
            )}

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
              />
            )}

            {promptAnchorSpacerHeight > 0 && (
              <div aria-hidden="true" style={{ height: promptAnchorSpacerHeight }} />
            )}

            {/* Clears the overlay composer so the last lines can scroll fully into view. */}
            <div aria-hidden="true" style={{ height: bottomComposerHeight }} />

            <div ref={messagesEndRef} />
                </>
              )}
            </div>
          </div>
        </div>
        <ConversationNavigator
          turns={conversationTurns}
          scrollContainerRef={scrollContainerRef}
          onSelect={selectConversationTurn}
        />
      </div>

      <div ref={bottomComposerRef} className="absolute inset-x-0 bottom-0 z-20">
        <div
          style={{
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <ExtensionWidgets widgets={belowEditorWidgets} />
          </div>
        </div>
        {chatInputElement}
      </div>
      </div>
      </>
      )}
    </div>
  );
}

function ExtensionWidgets({ widgets }: { widgets: Array<{ key: string; lines: string[] }> }) {
  if (widgets.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
      {widgets.map((widget) => (
        <div
          key={widget.key}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 7,
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "5px 9px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            {widget.key}
          </div>
          <pre style={{ margin: 0, padding: "8px 9px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)" }}>
            {widget.lines.join("\n")}
          </pre>
        </div>
      ))}
    </div>
  );
}

function NoticeShelf({ notices, floating = false, align = "left" }: { notices: NoticeItem[]; floating?: boolean; align?: "left" | "right" }) {
  if (notices.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "right" ? "flex-end" : "stretch",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "var(--danger)"
          : notice.type === "warning"
            ? "var(--warning)"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        return (
          <div
            key={notice.id}
            className={`notice-shelf-item is-${notice.type}${floating ? " is-floating" : ""}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minHeight: 46,
              height: 46,
              maxHeight: 46,
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: 10,
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              fontSize: 13,
              lineHeight: 1.35,
              transformOrigin: "top center",
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
              padding: "0 11px",
            }}
          >
            <span
              className="notice-shelf-indicator"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
              }}
            />
            <span className="notice-shelf-message" style={{ padding: "10px 0", minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
  }, [request]);

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 100%)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{request.title}</div>
          <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{t("chat.extensionRequest")}</div>
        </div>

        <div style={{ padding: 14 }}>
          {request.method === "confirm" && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{request.message}</div>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 8 }}>
              {request.options.map((option) => (
                <button
                  key={option}
                  onClick={() => onRespond(request, { value: option })}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitValue();
                if (e.key === "Escape") onRespond(request, { cancelled: true });
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 13,
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onRespond(request, { cancelled: true });
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
             {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                cursor: "pointer",
              }}
            >
               {t("chat.confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                cursor: "pointer",
              }}
            >
               {t("chat.submit")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) => (
    Object.keys(segment.style).length > 0
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const displayLines = normalizeCustomPanelLines(request.lines);

  useEffect(() => {
    inputRef.current?.focus();
  }, [request.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
          <button
            onClick={() => onInput(request, "\x03")}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
             {t("chat.close")}
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, 100vh - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}
