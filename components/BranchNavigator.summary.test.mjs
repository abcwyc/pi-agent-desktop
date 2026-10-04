import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const navigatorSource = await readFile(new URL("./BranchNavigator.tsx", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const themeSource = await readFile(new URL("../app/native-theme.css", import.meta.url), "utf8");

test("a plain click stays a plain switch; the summarized switch is its own action", () => {
  // Rows are also how branches are browsed, so asking on every click would get in the way.
  assert.match(navigatorSource, /onClick=\{onSelect \? \(\) => onSelect\(rep\.entry\.id\) : undefined\}/);
  assert.match(navigatorSource, /summary && !isOnPath && summary\.targetId !== rep\.entry\.id && \(/);
  assert.match(navigatorSource, /onLeafChange\(id, \{ summarize: true, customInstructions: customInstructions\.trim\(\) \|\| undefined \}\)/);
  // Locked switching hides the action with the click.
  assert.match(navigatorSource, /useMemo<BranchSummaryControls \| undefined>\(\(\) => locked \? undefined :/);
  // Touch screens have no hover to reveal it.
  assert.match(themeSource, /@media \(hover: none\) \{\s*\.branch-summary-action \{ opacity: 1; \}/);
});

test("the summary runs server-first, can be stopped, and holds the composer", () => {
  assert.match(hookSource, /type: "navigate_tree",\s*targetId: leafId,\s*summarize: true,/);
  assert.match(hookSource, /sendAgentCommand\(sid, \{ type: "abort_branch_summary" \}\)/);
  assert.match(hookSource, /agentRunningRef\.current \|\| bashRunningRef\.current \|\| branchSummaryHolds\(branchSummarySessionIdRef\.current, sessionIdRef\.current\)\) \{\s*restoreSubmission/);
  assert.match(chatInputSource, /\{branchSummaryPending && \([\s\S]*?chat\.branchSummarizing[\s\S]*?onClick=\{onAbortBranchSummary\}/);
});
