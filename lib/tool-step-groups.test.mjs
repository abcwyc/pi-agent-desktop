import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { formatStepSeconds, groupToolSteps, isToolOnlyStep, stepKind, summarizeToolSteps } = await jiti.import("./tool-step-groups.ts");

let ids = 0;
const call = (toolName, input = {}) => ({ type: "toolCall", toolCallId: `c${++ids}`, toolName, input });
const step = (blocks, extra = {}) => ({ role: "assistant", content: blocks, timestamp: 1000, ...extra });
const thinking = (text = "let me look") => ({ type: "thinking", thinking: text });
const text = (value) => ({ type: "text", text: value });
const result = (toolCallId, extra = {}) => ({ role: "toolResult", toolCallId, content: [], timestamp: 4000, ...extra });

test("a step with only thinking and tool calls is a tool step; text, images and notices are not", () => {
  assert.equal(isToolOnlyStep(step([call("bash")])), true);
  assert.equal(isToolOnlyStep(step([thinking(), call("bash"), call("read")])), true);
  assert.equal(isToolOnlyStep(step([thinking(), text("  "), call("bash")])), true, "blank text says nothing");
  assert.equal(isToolOnlyStep(step([thinking(), text("Let me check the config."), call("bash")])), false);
  assert.equal(isToolOnlyStep(step([{ type: "image", data: "", mimeType: "image/png" }, call("bash")])), false);
  assert.equal(isToolOnlyStep(step([thinking()])), false);
  assert.equal(isToolOnlyStep(step([call("bash")], { stopReason: "error", errorMessage: "boom" })), false);
  assert.equal(isToolOnlyStep({ role: "user", content: "hi" }), false);
  assert.equal(stepKind(result("x")), "neutral");
  assert.equal(stepKind({ role: "custom", customType: "x", display: false, content: "" }), "neutral");
  assert.equal(stepKind({ role: "custom", customType: "x", display: true, content: "" }), "other");
});

const kinds = (letters) => [...letters].map((letter) => ({ letter, kind: letter === "t" ? "tool" : letter === "n" ? "neutral" : "other" }));
const shape = (segments) => segments.map((segment) => (segment.kind === "group" ? `[${segment.items.map((item) => item.letter).join("")}]` : segment.item.letter)).join(" ");

test("two or more tool steps fold; text ends a run; results ride along", () => {
  const kindOf = (item) => item.kind;
  assert.equal(shape(groupToolSteps(kinds("utntnotnuo"), kindOf)), "u [tntn] o t n u o");
  assert.equal(shape(groupToolSteps(kinds("ttt"), kindOf)), "[ttt]");
  assert.equal(shape(groupToolSteps(kinds("tot"), kindOf)), "t o t", "a single step stays as it is");
  assert.equal(shape(groupToolSteps(kinds("ntt"), kindOf)), "n [tt]", "a result before a run is not part of it");
  assert.equal(shape(groupToolSteps(kinds(""), kindOf)), "");
});

test("a running turn keeps its newest tool step in view", () => {
  const kindOf = (item) => item.kind;
  assert.equal(shape(groupToolSteps(kinds("utntnt"), kindOf, { keepLastVisible: true })), "u [tntn] t");
  assert.equal(shape(groupToolSteps(kinds("utntn"), kindOf, { keepLastVisible: true })), "u t n t n", "two steps minus the live one is one: no fold");
  assert.equal(shape(groupToolSteps(kinds("utttn"), kindOf, { keepLastVisible: true })), "u [tt] t n");
  // A run that ended before the tail is folded whole.
  assert.equal(shape(groupToolSteps(kinds("tttot"), kindOf, { keepLastVisible: true })), "[ttt] o t");
});

test("the summary counts tools, time, failures and calls still running", () => {
  const a = call("bash", { command: "npm test" });
  const b = call("read", { path: "a.ts" });
  const c = call("bash", { command: "git status" });
  const d = call("bash", { command: "ls" });
  const messages = [step([thinking(), a, b]), result(a.toolCallId), step([c], { timestamp: 10_000 }), step([d], { timestamp: 20_000 })];
  const results = new Map([
    [a.toolCallId, result(a.toolCallId, { timestamp: 4000 })],
    [b.toolCallId, result(b.toolCallId, { timestamp: 2000, isError: true })],
    [c.toolCallId, result(c.toolCallId, { timestamp: 75_000 })],
  ]);
  const summary = summarizeToolSteps(messages, results);
  assert.deepEqual(summary.byTool, [["bash", 3], ["read", 1]]);
  assert.equal(summary.steps, 3);
  assert.equal(summary.calls, 4);
  assert.equal(summary.failed, 1);
  assert.equal(summary.pending, 1);
  assert.equal(summary.seconds, 3 + 1 + 65);
  assert.equal(summary.lastCall, d);
  assert.equal(summarizeToolSteps([step([call("bash")])], new Map()).seconds, null);
});

test("durations read like the tool cards, scaled up", () => {
  assert.equal(formatStepSeconds(0), "0s");
  assert.equal(formatStepSeconds(45), "45s");
  assert.equal(formatStepSeconds(60), "1m");
  assert.equal(formatStepSeconds(72), "1m 12s");
  assert.equal(formatStepSeconds(3720), "1h 2m");
});
