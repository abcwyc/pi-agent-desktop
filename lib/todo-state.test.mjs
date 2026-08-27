import test from "node:test";
import assert from "node:assert/strict";

const {
  parseTodoWidgetLines,
  serializeTodoWidgetLines,
  TODO_WIDGET_KEY,
} = await import("./todo-state.ts");

test("TODO_WIDGET_KEY is the desktop-reserved todo widget key", () => {
  assert.equal(TODO_WIDGET_KEY, "pi-agent-desktop:todo");
});

test("serializeTodoWidgetLines encodes one task per JSON line, round-trips", () => {
  const state = {
    revision: 3,
    tasks: [
      { key: "a", subject: "Alpha", status: "in_progress", description: "desc" },
      { key: "b", subject: "Beta" },
    ],
  };
  const lines = serializeTodoWidgetLines(state);
  assert.equal(lines.length, 2);
  // Each line is independent JSON (structured data in a string[]).
  assert.deepEqual(JSON.parse(lines[0]), { key: "a", subject: "Alpha", status: "in_progress", description: "desc" });
  assert.deepEqual(JSON.parse(lines[1]), { key: "b", subject: "Beta" });

  const parsed = parseTodoWidgetLines(lines);
  assert.deepEqual(parsed?.tasks, state.tasks);
});

test("parseTodoWidgetLines skips blank / non-JSON / invalid lines", () => {
  const lines = [
    "",
    "not json",
    JSON.stringify({ key: "a", subject: "A" }),
    JSON.stringify({ subject: "missing-key" }), // invalid: no key
    JSON.stringify({ key: "b", status: "bogus" }), // invalid status
    JSON.stringify({ key: "c", subject: "C" }),
  ];
  const parsed = parseTodoWidgetLines(lines);
  assert.deepEqual(parsed?.tasks.map((t) => t.key), ["a", "c"]);
});

test("parseTodoWidgetLines returns null for undefined / empty / all-invalid input", () => {
  assert.equal(parseTodoWidgetLines(undefined), null);
  assert.equal(parseTodoWidgetLines([]), null);
  assert.equal(parseTodoWidgetLines(["", "nope"]), null);
});
