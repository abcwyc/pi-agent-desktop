import assert from "node:assert/strict";
import test from "node:test";

const {
  buildCalendarEntries,
  calendarProjects,
  dayKey,
  groupByDay,
  isEntryVisible,
  monthCellItems,
  rangeOf,
  stepAnchor,
  visibleDays,
  TYPE_SCHEDULED,
} = await import("./calendar-helpers.ts");

// Local times, so the tests hold in any time zone.
const local = (y, m, d, h = 9, min = 0) => new Date(y, m - 1, d, h, min).getTime();

const session = (id, extra = {}) => ({
  id, path: `/s/${id}.jsonl`, cwd: "/code/app", projectRoot: "/code/app", created: "2026-11-01T00:00:00Z",
  modified: "2026-11-15T00:00:00Z", messageCount: 2, firstMessage: "x", ...extra,
});
const prompt = (at, text, extra = {}) => ({ at, entryId: `e${at}`, text, ...extra });
const data = (extra = {}) => ({ from: 0, to: 0, now: 0, prompts: {}, tasks: [], runs: [], planned: [], ...extra });
const build = (input) => buildCalendarEntries({ snapshots: [], runningSessionIds: new Set(), chatLabel: "Chats", sessions: [], ...input });

test("a month grid spans whole Monday-first weeks", () => {
  // November 2026 starts on a Sunday and ends on a Monday.
  const days = visibleDays("month", new Date(2026, 10, 15));
  assert.equal(days.length, 42);
  assert.equal(dayKey(days[0]), "2026-10-26");
  assert.equal(dayKey(days[41]), "2026-12-6");
  const week = visibleDays("week", new Date(2026, 10, 15));
  assert.deepEqual([dayKey(week[0]), dayKey(week[6])], ["2026-11-9", "2026-11-15"]);
  const { from, to } = rangeOf(week);
  assert.equal(from, new Date(2026, 10, 9).getTime());
  assert.equal(to, new Date(2026, 10, 16).getTime());
});

test("stepping moves by a week or to the first of the next month", () => {
  assert.equal(dayKey(stepAnchor("week", new Date(2026, 10, 15), 1)), "2026-11-22");
  assert.equal(dayKey(stepAnchor("month", new Date(2026, 0, 31), 1)), "2026-2-1");
  assert.equal(dayKey(stepAnchor("month", new Date(2026, 0, 31), -1)), "2025-12-1");
});

test("a session appears once per day, titled by that day's first prompt", () => {
  const entries = build({
    sessions: [session("a")],
    data: data({ prompts: { a: [
      prompt(local(2026, 11, 14, 16), "second day later"),
      prompt(local(2026, 11, 13, 10), "first question"),
      prompt(local(2026, 11, 13, 11), "follow-up"),
      prompt(local(2026, 11, 14, 9), "second day first"),
    ] } }),
  });
  assert.deepEqual(entries.map((entry) => [entry.dayKey, entry.title, entry.prompts.length]), [
    ["2026-11-13", "first question", 2],
    ["2026-11-14", "second day first", 2],
  ]);
});

test("a named session is titled by its name on every day", () => {
  const entries = build({
    sessions: [session("a", { name: "  Relay   deploy " })],
    data: data({ prompts: { a: [prompt(local(2026, 11, 13), "q1"), prompt(local(2026, 11, 14), "q2")] } }),
  });
  assert.deepEqual(entries.map((entry) => entry.title), ["Relay deploy", "Relay deploy"]);
  assert.equal(entries[0].sessionName, "Relay deploy");
});

test("live state marks only the session's latest day", () => {
  const entries = build({
    sessions: [session("a"), session("b"), session("c")],
    snapshots: [
      { sessionId: "a", running: false, runStartedAt: null, activity: null, waiting: [{ method: "confirm", prompt: "?" }], lastRun: null },
      { sessionId: "c", running: false, runStartedAt: null, activity: null, waiting: [], lastRun: { outcome: { status: "failed" }, finishedAt: 1 } },
    ],
    runningSessionIds: new Set(["b"]),
    data: data({ prompts: {
      a: [prompt(local(2026, 11, 13), "a1"), prompt(local(2026, 11, 14), "a2")],
      b: [prompt(local(2026, 11, 14, 10), "b1")],
      c: [prompt(local(2026, 11, 14, 11), "c1")],
    } }),
  });
  assert.deepEqual(entries.map((entry) => [entry.title, entry.status]), [
    ["a1", null], ["a2", "waiting"], ["b1", "running"], ["c1", "failed"],
  ]);
});

test("sub-agents, transient rows, unknown sessions and run sessions stay off the calendar", () => {
  const at = local(2026, 11, 14);
  const entries = build({
    sessions: [
      session("child", { relation: { kind: "subagent", parentSessionId: "x", profile: "p", description: "", status: "completed" } }),
      session("draft", { transient: true }),
      session("runSession"),
      session("tagged", { relation: { kind: "scheduled", taskId: "t", runId: "r0" } }),
    ],
    data: data({
      prompts: { child: [prompt(at, "c")], draft: [prompt(at, "d")], gone: [prompt(at, "g")], runSession: [prompt(at, "r")], tagged: [prompt(at, "t")] },
      tasks: [{ id: "t", name: "Brief", prompt: "p", cwd: "/code/app", schedule: { kind: "manual" }, enabled: true }],
      runs: [{ runId: "r1", taskId: "t", at, status: "succeeded", sessionId: "runSession" }],
    }),
  });
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.title]), [["run", "Brief"]]);
});

test("scheduled runs and planned slots carry their task and status", () => {
  const entries = build({
    sessions: [session("a")],
    data: data({
      tasks: [{ id: "t", name: "Brief", prompt: "p", cwd: "/code/app", schedule: { kind: "cron", expr: "0 9 * * *", timezone: "UTC" }, enabled: true }],
      runs: [
        { runId: "r1", taskId: "t", at: local(2026, 11, 13), status: "failed", error: "timeout" },
        { runId: "r2", taskId: "t", at: local(2026, 11, 14), status: "aborted" },
        { runId: "r3", taskId: "gone", at: local(2026, 11, 14), status: "succeeded" },
      ],
      planned: [{ taskId: "t", at: local(2026, 11, 16) }],
    }),
  });
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.status, entry.projectLabel]), [
    ["run", "failed", "app"], ["run", "aborted", "app"], ["planned", "planned", "app"],
  ]);
});

test("filters hide by type and by project; the project list puts chats last", () => {
  const at = local(2026, 11, 14);
  const entries = build({
    sessions: [session("a"), session("chat", { workspaceKind: "chat", cwd: "/chats/1" }), session("z", { cwd: "/code/zeta", projectRoot: "/code/zeta" })],
    data: data({
      prompts: { a: [prompt(at, "a")], chat: [prompt(at + 1, "c")], z: [prompt(at + 2, "z")] },
      tasks: [{ id: "t", name: "Brief", prompt: "p", cwd: "/code/app", schedule: { kind: "manual" }, enabled: true }],
      runs: [{ runId: "r", taskId: "t", at: at + 3, status: "succeeded" }],
    }),
  });
  assert.deepEqual(calendarProjects(entries).map((project) => project.label), ["app", "zeta", "Chats"]);
  const visible = (hidden) => entries.filter((entry) => isEntryVisible(entry, new Set(hidden))).map((entry) => entry.title);
  assert.deepEqual(visible([TYPE_SCHEDULED]), ["a", "c", "z"]);
  assert.deepEqual(visible(["chat", "/code/app"]), ["z"]);
});

test("a month cell keeps up to four rows, then three plus a count", () => {
  assert.deepEqual(monthCellItems([1, 2, 3, 4]), { shown: [1, 2, 3, 4], more: 0 });
  assert.deepEqual(monthCellItems([1, 2, 3, 4, 5, 6]), { shown: [1, 2, 3], more: 3 });
  const grouped = groupByDay([{ dayKey: "a", id: 1 }, { dayKey: "b", id: 2 }, { dayKey: "a", id: 3 }]);
  assert.deepEqual([...grouped].map(([key, list]) => [key, list.map((entry) => entry.id)]), [["a", [1, 3]], ["b", [2]]]);
});
