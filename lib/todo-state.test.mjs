import test from "node:test";
import assert from "node:assert/strict";

const { extractTodoState, extractTodoPanelState, TODO_PROTOCOL_TYPE } = await import("./todo-state.ts");

function todoMsg(details, i = 0) {
  return {
    role: "custom",
    customType: TODO_PROTOCOL_TYPE,
    details,
    id: `m${i}`,
    timestamp: new Date().toISOString(),
  };
}

test("returns null when the session has no todo protocol messages", () => {
  assert.equal(extractTodoPanelState([]), null);
  assert.equal(extractTodoPanelState([{ role: "user", content: "hi" }]), null);
});

test("active plan is the last snapshot; earlier snapshots are superseded", () => {
  const messages = [
    todoMsg({ revision: 1, tasks: [{ key: "a", subject: "A" }, { key: "b", subject: "B" }] }, 0),
    todoMsg({ revision: 2, tasks: [{ key: "a", subject: "A" }, { key: "c", subject: "C" }] }, 1),
  ];
  const state = extractTodoPanelState(messages);
  // b was dropped while pending (scope change) -> omitted; a/c remain, in order.
  assert.deepEqual(state?.tasks.map((t) => t.key), ["a", "c"]);
});

test("5 tasks with 2 completed -> next turn keeps one ordered T1..T5 list", () => {
  const messages = [
    todoMsg({
      revision: 1,
      tasks: [
        { key: "t1", subject: "T1" },
        { key: "t2", subject: "T2" },
        { key: "t3", subject: "T3" },
        { key: "t4", subject: "T4" },
        { key: "t5", subject: "T5" },
      ],
    }, 0),
    todoMsg({
      revision: 2,
      tasks: [
        { key: "t1", subject: "T1", status: "completed" },
        { key: "t2", subject: "T2", status: "completed" },
        { key: "t3", subject: "T3", status: "in_progress" },
        { key: "t4", subject: "T4" },
        { key: "t5", subject: "T5" },
      ],
    }, 1),
    // before_agent_start of the next turn drops the completed ones -> 3 remain.
    todoMsg({
      revision: 3,
      tasks: [
        { key: "t3", subject: "T3", status: "in_progress" },
        { key: "t4", subject: "T4" },
        { key: "t5", subject: "T5" },
      ],
    }, 2),
  ];
  const state = extractTodoPanelState(messages);
  // One list, T1..T5, completed ones re-inserted at their original position.
  assert.deepEqual(state?.tasks.map((t) => t.key), ["t1", "t2", "t3", "t4", "t5"]);
  assert.deepEqual(
    state?.tasks.map((t) => t.status),
    ["completed", "completed", "in_progress", undefined, undefined],
  );
  assert.equal(state?.revision, 3);
});

test("a task dropped while still pending is a scope change, not a completion", () => {
  const messages = [
    todoMsg({ revision: 1, tasks: [{ key: "a", subject: "A" }, { key: "b", subject: "B" }] }, 0),
    // b dropped while pending — scoped out, never completed.
    todoMsg({ revision: 2, tasks: [{ key: "a", subject: "A" }] }, 1),
  ];
  const state = extractTodoPanelState(messages);
  assert.deepEqual(state?.tasks.map((t) => t.key), ["a"]);
});

test("a completed task still in the current plan stays inline (not duplicated)", () => {
  const messages = [
    todoMsg({
      revision: 1,
      tasks: [
        { key: "a", subject: "A", status: "completed" },
        { key: "b", subject: "B" },
      ],
    }, 0),
  ];
  const state = extractTodoPanelState(messages);
  assert.deepEqual(state?.tasks.map((t) => t.key), ["a", "b"]);
  assert.equal(state?.tasks.filter((t) => t.status === "completed").length, 1);
});

test("completed tasks survive a cleared plan (tasks: []) without a compaction", () => {
  const messages = [
    todoMsg({ revision: 1, tasks: [{ key: "a", subject: "A", status: "completed" }] }, 0),
    todoMsg({ revision: 2, tasks: [] }, 1),
  ];
  const state = extractTodoPanelState(messages);
  assert.deepEqual(state?.tasks.map((t) => t.key), ["a"]);
  assert.equal(state?.tasks[0]?.status, "completed");
});

test("a compaction summary resets accumulated done history (no ghost tasks)", () => {
  const messages = [
    todoMsg({ revision: 1, tasks: [{ key: "t1", subject: "T1" }, { key: "t2", subject: "T2", status: "completed" }] }, 0),
    // Compaction boundary — the pre-compaction plan is summarized away.
    { role: "custom", customType: "compaction", content: "Summary", display: false, id: "comp1", timestamp: "" },
    // Extension re-emits an empty plan right after compaction.
    todoMsg({ revision: 2, tasks: [] }, 1),
  ];
  const state = extractTodoPanelState(messages);
  assert.deepEqual(state?.tasks, []);
});

test("a compaction summary resets: a fresh post-compaction plan shows only its own tasks", () => {
  const messages = [
    todoMsg({ revision: 1, tasks: [{ key: "old1", subject: "Old1" }, { key: "old2", subject: "Old2", status: "completed" }] }, 0),
    { role: "custom", customType: "compaction", content: "Summary", display: false, id: "comp1", timestamp: "" },
    todoMsg({ revision: 3, tasks: [{ key: "new1", subject: "New1" }, { key: "new2", subject: "New2" }] }, 1),
  ];
  const state = extractTodoPanelState(messages);
  assert.deepEqual(state?.tasks.map((t) => t.key), ["new1", "new2"]);
});

test("a compaction with no todo messages after it hides the panel (null)", () => {
  const messages = [
    todoMsg({ revision: 1, tasks: [{ key: "t1", subject: "T1", status: "completed" }] }, 0),
    { role: "custom", customType: "compaction", content: "Summary", display: false, id: "comp1", timestamp: "" },
  ];
  assert.equal(extractTodoPanelState(messages), null);
});

test("only the last compaction segment counts when a later todo update exists", () => {
  const messages = [
    todoMsg({ revision: 1, tasks: [{ key: "old", subject: "Old", status: "completed" }] }, 0),
    { role: "custom", customType: "compaction", content: "Summary", display: false, id: "comp1", timestamp: "" },
    todoMsg({ revision: 2, tasks: [{ key: "mid", subject: "Mid" }] }, 1),
    { role: "custom", customType: "compaction", content: "Summary 2", display: false, id: "comp2", timestamp: "" },
    todoMsg({ revision: 3, tasks: [{ key: "fresh", subject: "Fresh", status: "in_progress" }] }, 2),
  ];
  const state = extractTodoPanelState(messages);
  // mid was completed? no — dropped while pending in the 2nd segment, gone.
  assert.deepEqual(state?.tasks.map((t) => t.key), ["fresh"]);
});

test("new tasks added later keep first-appearance order after earlier done ones", () => {
  const messages = [
    todoMsg({ revision: 1, tasks: [{ key: "t1", subject: "T1" }] }, 0),
    todoMsg({ revision: 2, tasks: [{ key: "t1", subject: "T1", status: "completed" }, { key: "t2", subject: "T2" }] }, 1),
    todoMsg({ revision: 3, tasks: [{ key: "t2", subject: "T2" }] }, 2),
  ];
  const state = extractTodoPanelState(messages);
  // t1 completed & removed -> re-inserted first (original position), then t2.
  assert.deepEqual(state?.tasks.map((t) => t.key), ["t1", "t2"]);
});

test("extractTodoState still returns only the raw current plan (backward compat)", () => {
  const messages = [
    todoMsg({ revision: 1, tasks: [{ key: "a", subject: "A" }, { key: "b", subject: "B", status: "completed" }] }, 0),
    todoMsg({ revision: 2, tasks: [{ key: "a", subject: "A" }] }, 1),
  ];
  const active = extractTodoState(messages);
  // b completed but dropped: the raw protocol state has only the current plan.
  assert.deepEqual(active?.tasks.map((t) => t.key), ["a"]);
});
