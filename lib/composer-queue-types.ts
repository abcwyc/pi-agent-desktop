export interface PendingComposerMessage {
  id: string;
  message: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
}

export interface ComposerQueueSnapshot {
  pending?: PendingComposerMessage[];
  pendingVersion?: number;
}

export interface ComposerQueueActionResult extends ComposerQueueSnapshot {
  item: PendingComposerMessage | null;
}

/** A delayed HTTP snapshot must not resurrect entries already removed by SSE. */
export function mergeComposerQueueSnapshot(previous: ComposerQueueSnapshot, next: ComposerQueueSnapshot): ComposerQueueSnapshot {
  if (next.pendingVersion !== undefined && previous.pendingVersion !== undefined && next.pendingVersion < previous.pendingVersion) {
    return { pending: previous.pending, pendingVersion: previous.pendingVersion };
  }
  return { pending: next.pending ?? [], pendingVersion: next.pendingVersion };
}
