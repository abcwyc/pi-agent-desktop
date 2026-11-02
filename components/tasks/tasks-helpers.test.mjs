import assert from "node:assert/strict";
import test from "node:test";

const { describeActivity, groupTasks, projectLabel, sessionTitle } = await import("./tasks-helpers.ts");

const session = (id, modified, extra = {}) => ({
  id, path: `/s/${id}.jsonl`, cwd: "/code/app", projectRoot: "/code/app", created: modified, modified,
  messageCount: 2, firstMessage: `prompt ${id}`, ...extra,
});
const snapshot = (sessionId, extra = {}) => ({
  sessionId, running: false, runStartedAt: null, activity: null, waiting: [], lastRun: null, ...extra,
});

test("waiting beats running, sub-agents and transient sessions stay out, recent is newest first", () => {
  const sessions = [
    session("old", "2026-10-01T00:00:00Z"),
    session("new", "2026-10-31T00:00:00Z"),
    session("run", "2026-10-15T00:00:00Z"),
    session("ask", "2026-10-14T00:00:00Z"),
    session("streamed", "2026-10-13T00:00:00Z"),
    session("child", "2026-10-30T00:00:00Z", { relation: { kind: "subagent", parentSessionId: "run", profile: "x", description: "", status: "running" } }),
    session("draft", "2026-10-30T00:00:00Z", { transient: true }),
  ];
  const groups = groupTasks(sessions, [
    snapshot("run", { running: true, activity: { kind: "tool", name: "bash" } }),
    snapshot("ask", { running: true, waiting: [{ method: "confirm", prompt: "Delete?" }] }),
  ], new Set(["streamed"]));

  assert.deepEqual(groups.waiting.map((row) => row.session.id), ["ask"]);
  assert.deepEqual(groups.running.map((row) => row.session.id), ["run", "streamed"]);
  assert.deepEqual(groups.recent.map((row) => row.session.id), ["new", "old"]);
});

test("recent is capped", () => {
  const many = Array.from({ length: 30 }, (_, i) => session(`s${i}`, new Date(Date.UTC(2026, 9, 1, i)).toISOString()));
  assert.equal(groupTasks(many, [], new Set()).recent.length, 20);
});

test("labels: title, project folder or chats, and the current step", () => {
  const t = (key, values) => values ? `${key}(${Object.values(values).join(",")})` : key;
  assert.equal(sessionTitle(session("a", "2026-10-01T00:00:00Z", { name: "  Fix  login\n" })), "Fix login");
  assert.equal(projectLabel(session("a", "2026-10-01T00:00:00Z", { projectRoot: "/code/pi-gui/" }), "Chats"), "pi-gui");
  assert.equal(projectLabel(session("a", "2026-10-01T00:00:00Z", { workspaceKind: "chat" }), "Chats"), "Chats");
  assert.equal(describeActivity({ kind: "tool", name: "bash" }, t), "tasks.activity.tool(bash)");
  assert.equal(describeActivity({ kind: "retrying" }, t), "tasks.activity.retrying");
  assert.equal(describeActivity(null, t), "tasks.activity.thinking");
});

test("the poller fetches only while visible and something is live", async () => {
  const { createTasksPoller } = await import("./tasks-helpers.ts");
  const timers = [];
  let visible = true;
  let fetches = 0;
  let live = true;
  const poller = createTasksPoller({
    intervalMs: 3000,
    load: async () => { fetches += 1; return { live }; },
    isVisible: () => visible,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  const tick = async () => { const fn = timers.shift(); fn?.(); await new Promise((r) => setImmediate(r)); };

  await poller.start();
  assert.equal(fetches, 1);
  await tick();
  assert.equal(fetches, 2, "visible and live: polls");

  visible = false;
  await tick();
  assert.equal(fetches, 2, "hidden: the timer fires but nothing is fetched");
  assert.equal(timers.length, 0, "and nothing is rescheduled while hidden");

  visible = true;
  await poller.onVisibilityChange();
  assert.equal(fetches, 3, "coming back fetches at once");

  live = false;
  await tick();
  assert.equal(fetches, 4);
  assert.equal(timers.length, 0, "idle: stops polling");
  poller.stop();
});
