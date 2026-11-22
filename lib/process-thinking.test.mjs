import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { isWorkingStep, showsStepThinking } = await jiti.import("./message-display.ts");

const thinking = { type: "thinking", thinking: "x" };
const call = { type: "toolCall", toolCallId: "c", toolName: "bash", input: {} };
const text = (value) => ({ type: "text", text: value });

test("a step is working when it calls a tool; thinking alone is not", () => {
  assert.equal(isWorkingStep([thinking, call]), true);
  assert.equal(isWorkingStep([thinking, text("Let me look."), call]), true);
  assert.equal(isWorkingStep([thinking]), false, "it may be all a cut-off turn has");
  assert.equal(isWorkingStep([thinking, text("  ")]), false);
  assert.equal(isWorkingStep([thinking, text("The answer.")]), false);
  assert.equal(isWorkingStep([{ type: "image", data: "", mimeType: "image/png" }]), false);
});

test("thinking shows in answers, while streaming, or when the user asked for it", () => {
  assert.equal(showsStepThinking([thinking, call], { showProcessThinking: false }), false);
  assert.equal(showsStepThinking([thinking, call], { showProcessThinking: true }), true);
  assert.equal(showsStepThinking([thinking, call], { showProcessThinking: false, isStreaming: true }), true);
  assert.equal(showsStepThinking([thinking, text("Answer")], { showProcessThinking: false }), true);
});
