"use client";

import { useLayoutEffect, useState } from "react";
import type { StreamingState, StreamingStore } from "@/lib/streaming-message";

/**
 * One value of the streaming store; the component re-renders only when that
 * value changes. `select` must be stable (a module-level function).
 *
 * A plain state update rather than useSyncExternalStore: that one renders every
 * chunk on its own, while state updates let React batch the chunks that land
 * before it renders, and each render parses the reply's last block again.
 */
export function useStreamingSelector<T>(store: StreamingStore, select: (state: StreamingState) => T): T {
  const [value, setValue] = useState(() => select(store.getState()));
  useLayoutEffect(() => {
    const update = () => setValue(select(store.getState()));
    // A chunk may have landed between this render and the subscription.
    update();
    return store.subscribe(update);
  }, [store, select]);
  return value;
}

export const selectIsStreaming = (state: StreamingState) => state.isStreaming;
export const selectHasStreamingContent = (state: StreamingState) => Boolean(state.streamingMessage?.content.length);
export const selectStreamingMessage = (state: StreamingState) => state.streamingMessage;
