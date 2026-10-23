"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useI18n } from "../hooks/useI18n";

export interface ConversationTurnLocation {
  index: number;
  question: string;
  answer: string | null;
}

interface Props {
  turns: ConversationTurnLocation[];
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  enabled?: boolean;
  onSelect: (index: number) => void;
}

function nearestTurnIndex(event: ReactPointerEvent<HTMLDivElement>, count: number): number {
  const rect = event.currentTarget.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(rect.height, 1)));
  return Math.min(count - 1, Math.round(ratio * (count - 1)));
}

export function ConversationNavigator({ turns, scrollContainerRef, contentRef, enabled = true, onSelect }: Props) {
  const { t } = useI18n();
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [isHovering, setIsHovering] = useState(false);
  const [hasSpace, setHasSpace] = useState(false);
  const draggingRef = useRef(false);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const content = contentRef.current;
    let visible = false;

    const updateActive = () => {
      if (!visible || !container) return;
      const containerTop = container.getBoundingClientRect().top;
      const anchors = Array.from(container.querySelectorAll<HTMLElement>("[data-conversation-turn]"));
      if (anchors.length === 0) return;
      let closest = Number(anchors[0].dataset.conversationTurn ?? 0);
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const anchor of anchors) {
        const index = Number(anchor.dataset.conversationTurn);
        const distance = Math.abs(anchor.getBoundingClientRect().top - containerTop - 28);
        if (distance < closestDistance) {
          closest = index;
          closestDistance = distance;
        }
      }
      setActiveIndex(closest);
    };

    const updateLayout = () => {
      // The preferred text width is adjustable up to 2000px. A wide window
      // alone does not guarantee a free gutter next to the actual text column.
      const area = container?.getBoundingClientRect();
      const text = content?.getBoundingClientRect();
      visible = Boolean(enabled && turns.length >= 2 && area && text
        && area.width >= 1024 && text.left - area.left >= 64);
      setHasSpace(visible);
      if (visible) updateActive();
      else {
        setPreviewIndex(null);
        setIsHovering(false);
        draggingRef.current = false;
      }
    };
    updateLayout();
    if (!enabled || !container || !content || turns.length < 2) return;
    container.addEventListener("scroll", updateActive, { passive: true });
    const observer = new ResizeObserver(updateLayout);
    observer.observe(container);
    observer.observe(content);
    return () => {
      container.removeEventListener("scroll", updateActive);
      observer.disconnect();
    };
  }, [enabled, contentRef, scrollContainerRef, turns.length]);

  const selectFromPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (turns.length === 0) return;
    const index = nearestTurnIndex(event, turns.length);
    setPreviewIndex(index);
    setActiveIndex(index);
    onSelect(index);
  }, [onSelect, turns.length]);

  const preview = previewIndex == null ? null : turns[previewIndex];
  const navigatorHeight = turns.length * 2 + (turns.length - 1) * 8;
  const tickPositions = useMemo(() => turns.map((turn, index) => ({
    ...turn,
    top: 1 + index * 10,
  })), [turns]);

  if (!enabled || !hasSpace || turns.length < 2) return null;

  return (
    <div
      className={`conversation-navigator${isHovering ? " is-hovering" : ""}`}
      style={{ height: navigatorHeight }}
      onPointerEnter={() => setIsHovering(true)}
      onPointerLeave={() => {
        setIsHovering(false);
        if (!draggingRef.current) setPreviewIndex(null);
      }}
    >
      {preview && (
        // Clicking the card jumps to its turn, like clicking the tick beside it.
        // It is not a tab stop: the track's arrow keys already move between turns.
        <button
          type="button"
          className="conversation-navigator-preview"
          tabIndex={-1}
          title={t("chat.conversationNavigatorJump")}
          onClick={() => {
            if (previewIndex == null) return;
            setActiveIndex(previewIndex);
            onSelect(previewIndex);
          }}
        >
          <span className="conversation-navigator-question">{preview.question}</span>
          <span className="conversation-navigator-answer">
            {preview.answer || "…"}
          </span>
        </button>
      )}
      <div
        className="conversation-navigator-track"
        role="slider"
        aria-label={t("chat.conversationNavigator")}
        aria-valuemin={1}
        aria-valuemax={turns.length}
        aria-valuenow={activeIndex + 1}
        tabIndex={0}
        onBlur={() => { if (!draggingRef.current) setPreviewIndex(null); }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          const next = Math.max(0, Math.min(turns.length - 1, activeIndex + (event.key === "ArrowUp" ? -1 : 1)));
          setActiveIndex(next);
          setPreviewIndex(next);
          onSelect(next);
        }}
        onPointerDown={(event) => {
          draggingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          selectFromPointer(event);
        }}
        onPointerMove={(event) => {
          const index = nearestTurnIndex(event, turns.length);
          setPreviewIndex(index);
          if (draggingRef.current && index !== activeIndex) {
            setActiveIndex(index);
            onSelect(index);
          }
        }}
        onPointerUp={(event) => {
          draggingRef.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { draggingRef.current = false; }}
      >
        {tickPositions.map((turn, index) => {
          const previewDistance = previewIndex == null ? null : Math.abs(index - previewIndex);
          return (
            <span
              key={turn.index}
              className={`conversation-navigator-tick${previewDistance === 1 ? " is-near-preview-1" : ""}${previewDistance === 2 ? " is-near-preview-2" : ""}${index === previewIndex ? " is-preview" : ""}${turn.index === activeIndex ? " is-active" : ""}`}
              style={{ top: turn.top }}
            />
          );
        })}
      </div>
    </div>
  );
}
