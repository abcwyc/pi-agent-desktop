import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../hooks/useAgentSession.ts", import.meta.url);
const chatWindowUrl = new URL("./ChatWindow.tsx", import.meta.url);

function functionSlice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

test("context loads ignore stale sessions and out-of-order branch responses", async () => {
  const source = (await readFile(sourceUrl, "utf8")).replace(/\r\n/g, "\n");
  const body = functionSlice(source, "const loadContext = useCallback", "const loadTools = useCallback");
  assert.match(body, /requestId = \+\+contextLoadIdRef\.current/);
  assert.match(body, /sessionIdRef\.current === sid/);
  assert.match(body, /contextLoadIdRef\.current === requestId/);
  assert.match(body, /if \(!isCurrent\(\)\) return false/);
});

test("tool preset loads ignore stale sessions and out-of-order responses", async () => {
  const source = (await readFile(sourceUrl, "utf8")).replace(/\r\n/g, "\n");
  const body = functionSlice(source, "const loadTools = useCallback", "const promoteNewSession = useCallback");
  assert.match(body, /requestId = \+\+toolsLoadIdRef\.current/);
  assert.match(body, /sessionIdRef\.current === sid/);
  assert.match(body, /toolsLoadIdRef\.current === requestId/);
  // Merged form: the guard moved into one early return with the mounted check;
  // the pinned semantics (stale responses dropped via isCurrent) are unchanged.
  assert.match(body, /!tools \|\| !isCurrent\(\) \|\| !sessionHookMountedRef\.current\) return null/);
});

test("agent-end state refreshes cannot overwrite a switched session or newer run", async () => {
  const source = (await readFile(sourceUrl, "utf8")).replace(/\r\n/g, "\n");
  const body = functionSlice(source, 'case "agent_end"', 'case "agent_settled"');
  assert.match(body, /const sid = sessionIdRef\.current/);
  assert.match(body, /const sessionGeneration = sessionGenerationRef\.current/);
  assert.match(body, /const runId = promptRunIdRef\.current/);
  assert.match(body, /sessionIdRef\.current !== sid/);
  assert.match(body, /sessionGenerationRef\.current !== sessionGeneration/);
  assert.match(body, /promptRunIdRef\.current !== runId/);
});

test("a stale branch load cannot navigate the newly active session", async () => {
  const source = (await readFile(sourceUrl, "utf8")).replace(/\r\n/g, "\n");
  const body = functionSlice(source, "const handleLeafChange = useCallback", "const handleModelChange = useCallback");
  assert.match(body, /const loaded = await loadContext\(sid, leafId\)/);
  assert.match(body, /loaded && leafId && sessionIdRef\.current === sid/);
});

test("returning to a session restores its last scroll position", async () => {
  const source = (await readFile(sourceUrl, "utf8")).replace(/\r\n/g, "\n");
  // The save must happen inside the render-phase reset block: by the time an
  // effect cleanup runs for a session switch, the message list has already
  // been emptied in the same commit and the browser has clamped scrollTop to
  // 0, so a cleanup-time read records 0 for every switch (#scroll-restore).
  const resetBlock = functionSlice(source, "if (sessionIdentity !== appliedIdentity)", "const currentModel =");
  assert.match(resetBlock, /rememberScrollPosition\(previousIdentity, container\)/);
  assert.match(resetBlock, /opts\.onScrollPositionChange\(previousIdentity/);
  assert.match(resetBlock, /setMessages\(\[\]\)/);
  assert.match(resetBlock, /setData\(null\)/);
  assert.match(resetBlock, /sessionIdRef\.current = isNew \? null : existingSessionId \?\? null/);
  assert.match(resetBlock, /initialScrollDoneRef\.current = Boolean\(opts\.deferInitialScroll\)/);
  assert.match(source, /pendingInitialScrollTopRef\.current = sessionScrollTops\.get\(sessionIdentity\) \?\? null/);
  assert.match(source, /container\.scrollTop = savedScrollTop/);
});

test("the stable ChatWindow reloads whenever its session identity changes", async () => {
  const source = (await readFile(sourceUrl, "utf8")).replace(/\r\n/g, "\n");
  const effect = functionSlice(source, "// Load session on mount and whenever", "useEffect(() => {\n    onSystemPromptChange");
  assert.match(effect, /sessionIdRef\.current = session\.id/);
  // Merged form: showLoading is `!cached` so a restored snapshot skips the
  // spinner; the forced read is still the freshness check (includeState=true).
  assert.match(effect, /loadSession\(session\.id, !cached && !promoted, true, \{ force: true \}\)/);
  assert.match(effect, /\}, \[sessionIdentity\]\)/);
});

test("promoting a new session to its real id keeps the transcript on screen", async () => {
  const source = (await readFile(sourceUrl, "utf8")).replace(/\r\n/g, "\n");
  // promoteNewSession records the draft-key -> id move it is about to cause
  const promote = functionSlice(source, "const promoteNewSession = useCallback", "const ensureNewSession = useCallback");
  assert.match(promote, /promotedIdentityRef\.current = \{ from: provisionalDraftKey, to: sid \}/);
  // the render-phase switch skips the reset for exactly that move...
  const switchBlock = functionSlice(source, "const promotedIdentity = promotedIdentityRef.current", "} else if (sessionIdentity !== appliedIdentity) {");
  assert.match(switchBlock, /promotedIdentity\?\.from === appliedIdentity/);
  assert.match(switchBlock, /promotedIdentity\.to === sessionIdentity/);
  assert.doesNotMatch(switchBlock, /setMessages\(\[\]\)/);
  // ...and the mount load re-reads without the loading state or a stale snapshot
  const effect = functionSlice(source, "// Load session on mount and whenever", "useEffect(() => {\n    onSystemPromptChange");
  assert.match(effect, /const cached = promoted \? null : getSessionViewSnapshot\(session\.id\)/);
});

test("session loads reject A-B-A responses from an older generation", async () => {
  const source = (await readFile(sourceUrl, "utf8")).replace(/\r\n/g, "\n");
  const body = functionSlice(source, "const loadSession = useCallback", "const loadContext = useCallback");
  assert.match(body, /const sessionGeneration = sessionGenerationRef\.current/);
  assert.match(body, /sessionGenerationRef\.current === sessionGeneration/);
  assert.match(body, /if \(!isCurrent\(\)\) return null/);
  assert.match(body, /showLoading && !messagesLoaded && isCurrent\(\)/);
});

test("the stable ChatWindow resets viewport state for the selected session", async () => {
  const source = (await readFile(chatWindowUrl, "utf8")).replace(/\r\n/g, "\n");
  const block = functionSlice(source, "if (lazyLoadSessionKey !== appliedLazyLoadSessionKey)", "const searchMessage =");
  assert.match(block, /sessionVisibleCounts\.set\(appliedLazyLoadSessionKey, visibleCount\)/);
  assert.match(block, /sessionVisibleCounts\.get\(lazyLoadSessionKey\)/);
  assert.match(block, /setPendingScrollRestore\(nextPosition && !nextPosition\.atBottom \? nextPosition : null\)/);
  assert.match(block, /restoreStartedRef\.current = false/);
});
