// Todo protocol reference extension.
//
// A self-contained example: registers a `todo` tool the agent uses to maintain
// a plan, and emits the pi-agent-desktop todo protocol after every write so the
// desktop's left-nav panel shows it live.
//
// Install: copy to ~/.pi/agent/extensions/todo-protocol.ts
//
// If you already have a todo tool (e.g. @99percentpeople/pi-todo), you don't
// need this whole file — just add the emit step to it (see emitTodo() below).
// The protocol name "todo" is a customMessage customType, NOT a tool name, so
// it does not collide with a `todo` tool.

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const CUSTOM_TYPE = "todo"; // must match TODO_PROTOCOL_TYPE in lib/todo-state.ts
const MAX_TASKS = 50;

// The minimal shape the desktop validates (see docs/todo-protocol.md): only
// `tasks` is required. Extra fields (revision, description, dependsOn, ...) are
// optional and ignored by the desktop, so emit whatever your extension keeps.
function todoState(tasks) {
  return { tasks };
}

// Emit the protocol. Data goes in `details` (never enters LLM context);
// `content` stays empty so the model sees nothing.
function emitTodo(pi, state) {
  pi.sendMessage(
    {
      customType: CUSTOM_TYPE,
      content: "",
      display: false,
      details: state,
    },
    { triggerTurn: false },
  );
}

function statusOf(v) {
  return v === "in_progress" || v === "completed" ? v : "pending";
}

export default function (pi) {
  let state = todoState([]);

  function setState(next) {
    state = next;
    emitTodo(pi, state);
  }

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Maintain the task plan with one atomic update. Every call replaces the task list: include each key to keep, omit a key to delete it. Existing tasks may omit unchanged fields; new tasks require subject and status.",
    promptSnippet: "Maintain the task plan with one atomic update",
    promptGuidelines: [
      "When a task needs a plan of 3+ steps, define it yourself and call todo before beginning implementation.",
      "Each todo call replaces the task list. Include every key to keep; omitted keys are deleted.",
      "Mark work completed only after implementation and verification succeed.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          key: Type.String(),
          subject: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          status: Type.Optional(StringEnum(["pending", "in_progress", "completed"])),
          dependsOn: Type.Optional(Type.Array(Type.String())),
        }),
        { maxItems: MAX_TASKS },
      ),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const next = params.tasks.slice(0, MAX_TASKS).map((t) => ({
        key: t.key,
        ...(t.subject !== undefined ? { subject: t.subject } : {}),
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.status !== undefined ? { status: statusOf(t.status) } : {}),
        ...(t.dependsOn !== undefined ? { dependsOn: t.dependsOn } : {}),
      }));
      setState(todoState(next));
      return { content: [{ type: "text", text: `Todo plan updated (${next.length} tasks).` }] };
    },
  });
}
