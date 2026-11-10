// Prism tokenizes a code fence in the render that shows it: about 5-10 ms per
// 1,000 characters of TypeScript on a desktop (a 32 KB file takes 180 ms). A
// reply that finishes streaming, or a session opened on a long history,
// highlighted every fence in that one task. Within a task the first
// HIGHLIGHT_TASK_BUDGET characters are still highlighted at once; the other
// fences render without colors first and get them one per idle slice, newest
// first (the end of a chat is what is on screen).

const HIGHLIGHT_TASK_BUDGET = 2_000;
const FALLBACK_IDLE_DELAY_MS = 50;

let taskBudget = HIGHLIGHT_TASK_BUDGET;
let budgetResetQueued = false;
const waiting: Array<() => void> = [];
let releaseQueued = false;

/** True when a fence of `chars` characters may be highlighted in this task. */
export function takeHighlightBudget(chars: number): boolean {
  if (!budgetResetQueued) {
    budgetResetQueued = true;
    setTimeout(() => {
      taskBudget = HIGHLIGHT_TASK_BUDGET;
      budgetResetQueued = false;
    }, 0);
  }
  if (chars > taskBudget) return false;
  taskBudget -= chars;
  return true;
}

function whenIdle(run: () => void): void {
  // Safari has no requestIdleCallback.
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 500 });
  } else {
    setTimeout(run, FALLBACK_IDLE_DELAY_MS);
  }
}

function releaseNewest(): void {
  releaseQueued = false;
  waiting.pop()?.();
  if (waiting.length > 0) queueRelease();
}

function queueRelease(): void {
  if (releaseQueued) return;
  releaseQueued = true;
  whenIdle(releaseNewest);
}

/**
 * Calls `show` in a later idle slice, one waiting fence per slice so each
 * highlight render gets a task of its own. Returns a cancel for unmount.
 */
export function waitForHighlight(show: () => void): () => void {
  waiting.push(show);
  queueRelease();
  return () => {
    const index = waiting.indexOf(show);
    if (index !== -1) waiting.splice(index, 1);
  };
}
