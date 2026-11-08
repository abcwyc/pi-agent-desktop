import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getTurnDurationMs, formatTurnDuration } = await jiti.import("./turn-duration.ts");

const user = (timestamp) => ({ role: "user", content: "hi", timestamp });
const reply = (timestamp, durationMs, stopReason = "toolUse") => ({ role: "assistant", content: [], model: "m", provider: "p", timestamp, durationMs, stopReason });
const result = (timestamp) => ({ role: "toolResult", toolCallId: "c", content: [], timestamp });

test("a turn runs from the user's message until its last response ended", () => {
  const messages = [user(1_000), reply(1_200, 3_000), result(4_500), reply(4_600, 2_400, "stop")];
  assert.equal(getTurnDurationMs(messages, 0, messages.length), 6_000);
});

test("only the messages before the next anchor belong to the turn", () => {
  const messages = [user(1_000), reply(1_100, 900, "stop"), user(10_000), reply(10_100, 5_000, "stop")];
  assert.equal(getTurnDurationMs(messages, 0, 2), 1_000);
  assert.equal(getTurnDurationMs(messages, 2, 4), 5_100);
});

test("a tool result after the last response, as in an aborted turn, ends the turn", () => {
  const messages = [user(1_000), reply(1_100, 900), result(8_000)];
  assert.equal(getTurnDurationMs(messages, 0, messages.length), 7_000);
});

test("no duration without the anchor's time or the last response's recorded length", () => {
  assert.equal(getTurnDurationMs([user(undefined), reply(1_100, 900, "stop")], 0, 2), undefined);
  assert.equal(getTurnDurationMs([user(1_000), reply(1_100, 900), result(2_100), reply(2_200, undefined, "stop")], 0, 4), undefined);
  assert.equal(getTurnDurationMs([user(1_000)], 0, 1), undefined);
});

test("a run an extension's message started later is timed from that message, not the answer", () => {
  // pi's file-trigger example: pi.sendMessage({ customType, content, display: true }, { triggerTurn: true }), no anchor.
  const trigger = (timestamp) => ({ role: "custom", customType: "file-trigger", content: "x", display: true, timestamp });
  const messages = [user(1_000), reply(1_100, 900, "stop"), trigger(3_600_000), reply(3_600_050, 2_000, "stop")];
  // 1 s for the first run, 2.05 s for the second; the hour between them is not the turn's.
  assert.equal(getTurnDurationMs(messages, 0, messages.length), 3_050);
  // A message the answer's own run left after it (sent without a new run) moves nothing.
  const late = [user(1_000), reply(1_100, 900, "stop"), trigger(1_500)];
  assert.equal(getTurnDurationMs(late, 0, late.length), 1_000);
});

test("durations read in whole seconds, then minutes and hours", () => {
  assert.equal(formatTurnDuration(0), "0s");
  assert.equal(formatTurnDuration(14_900), "14s");
  assert.equal(formatTurnDuration(185_000), "3m 5s");
  assert.equal(formatTurnDuration(3_725_000), "1h 2m 5s");
  assert.equal(formatTurnDuration(-50), "0s");
});
