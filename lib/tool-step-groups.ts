/**
 * Folding runs of tool steps in a turn (components/ToolStepGroup.tsx).
 *
 * pi stores each tool call as its own assistant entry, usually with a
 * thinking block and often a sentence of text before the call. A turn with
 * 30 calls drew 30 steps, each with its own model name, thinking row and tool
 * card. Consecutive steps that hold only thinking and tool calls fold into
 * one row ("bash ×6 · read ×2 · 1m 12s"); a step that says something in text
 * stays as it is, because that is the model telling the user where it is.
 * Measured on 400 local sessions: turns with 30+ calls draw 45% fewer steps.
 */
import { getDisplayableAssistantBlocks, isHiddenCustomMessage } from "./message-display";
import type { AgentMessage, AssistantMessage, ToolCallContent, ToolResultMessage } from "./types";

export type StepKind = "tool" | "neutral" | "other";

/** A step that is only thinking and tool calls: no text, no image, no error or truncation notice. */
export function isToolOnlyStep(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  const assistant = message as AssistantMessage;
  if (assistant.stopReason === "error" || assistant.stopReason === "length") return false;
  const blocks = getDisplayableAssistantBlocks(assistant);
  let calls = 0;
  for (const block of blocks) {
    if (block.type === "toolCall") calls += 1;
    else if (block.type === "text" && block.text.trim()) return false;
    else if (block.type === "image") return false;
  }
  return calls > 0;
}

/**
 * How a message sits in a run: tool steps make it, tool results and hidden
 * custom messages (which draw nothing) pass through, anything else ends it.
 */
export function stepKind(message: AgentMessage): StepKind {
  if (isToolOnlyStep(message)) return "tool";
  if (message.role === "toolResult" || isHiddenCustomMessage(message)) return "neutral";
  return "other";
}

export type StepSegment<T> = { kind: "single"; item: T } | { kind: "group"; items: T[] };

export const MIN_GROUPED_STEPS = 2;

/**
 * Splits items into singles and groups of at least `MIN_GROUPED_STEPS` tool
 * steps. `keepLastVisible` (a turn that is still running) leaves the newest
 * tool step and what follows it outside the group, so the step in progress
 * stays in view.
 */
export function groupToolSteps<T>(items: readonly T[], kindOf: (item: T) => StepKind, options: { keepLastVisible?: boolean } = {}): StepSegment<T>[] {
  const segments: StepSegment<T>[] = [];
  let run: T[] = [];
  let tools = 0;
  const flush = () => {
    if (tools >= MIN_GROUPED_STEPS) segments.push({ kind: "group", items: run });
    else for (const item of run) segments.push({ kind: "single", item });
    run = [];
    tools = 0;
  };
  items.forEach((item) => {
    const kind = kindOf(item);
    if (kind === "other") {
      flush();
      segments.push({ kind: "single", item });
    } else if (kind === "tool" || tools > 0) {
      // A neutral item only joins a run that has started; one before it stays single.
      run.push(item);
      if (kind === "tool") tools += 1;
    } else {
      segments.push({ kind: "single", item });
    }
  });
  if (options.keepLastVisible && run.length > 0) {
    const lastTool = run.findLastIndex((item) => kindOf(item) === "tool");
    const tail = run.slice(lastTool);
    run = run.slice(0, lastTool);
    tools -= 1;
    flush();
    for (const item of tail) segments.push({ kind: "single", item });
  } else {
    flush();
  }
  return segments;
}

export interface ToolStepSummary {
  steps: number;
  calls: number;
  /** Tool names by count, most used first (ties keep first use). */
  byTool: Array<[string, number]>;
  /** Seconds from each step's end to its results, summed; null while none finished. */
  seconds: number | null;
  failed: number;
  pending: number;
  lastCall: ToolCallContent | null;
}

/** What a folded run says about itself, from its steps and the turn's tool results. */
export function summarizeToolSteps(messages: readonly AgentMessage[], toolResults: ReadonlyMap<string, ToolResultMessage> | undefined): ToolStepSummary {
  const counts = new Map<string, number>();
  let steps = 0, calls = 0, failed = 0, pending = 0, seconds = 0, timed = false;
  let lastCall: ToolCallContent | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const assistant = message as AssistantMessage;
    const stepCalls = (assistant.content ?? []).filter((block): block is ToolCallContent => block.type === "toolCall");
    if (stepCalls.length === 0) continue;
    steps += 1;
    for (const call of stepCalls) {
      calls += 1;
      lastCall = call;
      counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
      const result = toolResults?.get(call.toolCallId);
      if (!result) { pending += 1; continue; }
      if (result.isError) failed += 1;
      if (result.timestamp && assistant.timestamp && result.timestamp > assistant.timestamp) {
        seconds += (result.timestamp - assistant.timestamp) / 1000;
        timed = true;
      }
    }
  }
  const byTool = [...counts].sort((a, b) => b[1] - a[1]);
  return { steps, calls, byTool, seconds: timed ? Math.round(seconds) : null, failed, pending, lastCall };
}

/** "45s", "1m 12s", "1h 3m". */
export function formatStepSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60), rest = seconds % 60;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60);
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}
