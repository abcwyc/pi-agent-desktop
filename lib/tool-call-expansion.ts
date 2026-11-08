/**
 * Remembers which tool-call cards the user has expanded, keyed by toolCallId.
 *
 * A streaming assistant message is rendered from the streaming store, then re-rendered
 * from `messages` after `message_end`, and moves into Process details when the run
 * ends. Each of those hops remounts `ToolCallBlock`, and so does the session file's
 * read when the message's key cannot pass to its entry (lib/message-keys.ts), as in
 * a run longer than the first page; otherwise the read keeps the card mounted. Plain
 * component state would collapse a card the user just opened. Keeping the set
 * outside React lets the remounted card start expanded without threading state
 * through every message component.
 */
const expandedToolCalls = new Set<string>();

export function isToolCallExpanded(toolCallId: string | undefined): boolean {
  return toolCallId !== undefined && expandedToolCalls.has(toolCallId);
}

export function setToolCallExpanded(toolCallId: string | undefined, expanded: boolean): void {
  if (!toolCallId) return;
  if (expanded) expandedToolCalls.add(toolCallId);
  else expandedToolCalls.delete(toolCallId);
}

export function clearExpandedToolCalls(): void {
  expandedToolCalls.clear();
}
