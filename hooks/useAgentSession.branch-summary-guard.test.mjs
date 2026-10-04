import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const sourceText = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("useAgentSession.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function find(node, match) {
  if (match(node)) return node;
  return ts.forEachChild(node, (child) => find(child, match));
}

function compile(text) {
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText.trim().replace(/;$/, "");
}

const helperNode = find(source, (n) => ts.isFunctionDeclaration(n) && n.name?.text === "branchSummaryHolds");
const leafChangeNode = find(source, (n) => ts.isVariableDeclaration(n) && n.name.getText(source) === "handleLeafChange");
assert.ok(helperNode, "branchSummaryHolds not found");
assert.ok(leafChangeNode, "handleLeafChange not found");

const helperJs = compile(helperNode.getText(source));
const branchSummaryHolds = new Script(`${helperJs}; branchSummaryHolds`).runInNewContext({});

function leafChangeHarness({ pendingSummarySessionId, currentSessionId }) {
  const calls = { activeLeaf: [], summarize: [], loadContext: [] };
  const context = {
    branchSummaryHolds,
    bashRunningRef: { current: false },
    agentRunningRef: { current: false },
    isCompacting: false,
    branchSummarySessionIdRef: { current: pendingSummarySessionId },
    sessionIdRef: { current: currentSessionId },
    sessionReadIdRef: { current: 0 },
    summarizeAndNavigate: async (leafId) => { calls.summarize.push(leafId); },
    setActiveLeafId: (leafId) => { calls.activeLeaf.push(leafId); },
    invalidateSessionData: () => {},
    loadContext: async (sid, leafId) => { calls.loadContext.push([sid, leafId]); return false; },
    sendAgentCommand: async () => {},
    addNotice: () => {},
    t: (key) => key,
  };
  const handlerJs = compile(leafChangeNode.initializer.arguments[0].getText(source));
  const handleLeafChange = new Script(`(${handlerJs})`).runInNewContext(context);
  return { handleLeafChange, calls };
}

test("a branch summary holds only the session it is summarizing", () => {
  assert.equal(branchSummaryHolds(null, null), false);
  assert.equal(branchSummaryHolds(null, "a"), false);
  assert.equal(branchSummaryHolds("a", "a"), true);
  assert.equal(branchSummaryHolds("a", "b"), false);
  assert.equal(branchSummaryHolds("a", null), false);
});

test("a summary still running for the previous session does not lock branch switches in the next", async () => {
  const { handleLeafChange, calls } = leafChangeHarness({ pendingSummarySessionId: "a", currentSessionId: "b" });
  await handleLeafChange("leaf-1");
  assert.deepEqual(calls.activeLeaf, ["leaf-1"]);
  assert.deepEqual(calls.loadContext, [["b", "leaf-1"]]);
});

test("a summary running for the current session still locks its branch switches", async () => {
  const { handleLeafChange, calls } = leafChangeHarness({ pendingSummarySessionId: "a", currentSessionId: "a" });
  await handleLeafChange("leaf-1");
  await handleLeafChange("leaf-2", { summarize: true });
  assert.deepEqual(calls.activeLeaf, []);
  assert.deepEqual(calls.summarize, []);
});

test("send, branch switch and the lock banner all scope the summary to the current session", () => {
  const sendSource = sourceText.slice(
    sourceText.indexOf("  const handleSend = useCallback"),
    sourceText.indexOf("  const handleSend = useCallback") + 600,
  );
  assert.match(sendSource, /if \(agentRunningRef\.current \|\| bashRunningRef\.current \|\| branchSummaryHolds\(branchSummarySessionIdRef\.current, sessionIdRef\.current\)\) \{/);
  assert.match(sourceText, /const branchSummaryPending = branchSummaryHolds\(branchSummarySessionId, session\?\.id \?\? null\);/);
  // No run/busy guard may test the bare ref: it still holds the previous session's id after a switch.
  // (summarizeAndNavigate's own `!sid || branchSummarySessionIdRef.current` keeps summaries single-flight.)
  assert.doesNotMatch(sourceText, /(?:Ref\.current|isCompacting) \|\| branchSummarySessionIdRef\.current\)/);
});
