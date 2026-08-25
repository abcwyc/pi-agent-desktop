import assert from "node:assert/strict";
import test from "node:test";
import { groupByProject, findProjectForSession } from "./project-group.ts";

function makeSession(overrides) {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    path: overrides.path ?? `/sessions/${overrides.id ?? "x"}.jsonl`,
    cwd: overrides.cwd ?? "/repo",
    name: overrides.name,
    created: overrides.created ?? "2026-01-01T00:00:00.000Z",
    modified: overrides.modified ?? "2026-01-01T00:00:00.000Z",
    messageCount: overrides.messageCount ?? 1,
    firstMessage: overrides.firstMessage ?? "hi",
    parentSessionId: overrides.parentSessionId,
    projectRoot: overrides.projectRoot,
    worktreeBranch: overrides.worktreeBranch,
    ...overrides,
  };
}

test("groupByProject: empty input returns empty array", () => {
  assert.deepEqual(groupByProject([]), []);
});

test("groupByProject: sessions with same projectRoot collapse into one group", () => {
  const a = makeSession({ id: "a", cwd: "/repo", projectRoot: "/repo", modified: "2026-01-02T00:00:00.000Z" });
  const b = makeSession({ id: "b", cwd: "/repo-wt/feat", projectRoot: "/repo", modified: "2026-01-01T00:00:00.000Z" });
  const groups = groupByProject([a, b]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].projectRoot, "/repo");
  assert.equal(groups[0].sessions.length, 2);
});

test("groupByProject: sessions without projectRoot fall back to cwd", () => {
  const a = makeSession({ id: "a", cwd: "/orphan", modified: "2026-01-01T00:00:00.000Z" });
  const b = makeSession({ id: "b", cwd: "/orphan", projectRoot: undefined, modified: "2026-01-02T00:00:00.000Z" });
  const groups = groupByProject([a, b]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].projectRoot, "/orphan");
  assert.equal(groups[0].displayName, "orphan");
});

test("groupByProject: groups sorted by latestModified desc", () => {
  const a = makeSession({ id: "a", cwd: "/A", projectRoot: "/A", modified: "2026-01-01T00:00:00.000Z" });
  const b = makeSession({ id: "b", cwd: "/B", projectRoot: "/B", modified: "2026-01-05T00:00:00.000Z" });
  const c = makeSession({ id: "c", cwd: "/C", projectRoot: "/C", modified: "2026-01-03T00:00:00.000Z" });
  const groups = groupByProject([a, b, c]);
  assert.deepEqual(groups.map((g) => g.projectRoot), ["/B", "/C", "/A"]);
});

test("groupByProject: latestModified is the max across group sessions", () => {
  const old = makeSession({ id: "old", cwd: "/X", projectRoot: "/X", modified: "2025-12-01T00:00:00.000Z" });
  const mid = makeSession({ id: "mid", cwd: "/X", projectRoot: "/X", modified: "2026-02-01T00:00:00.000Z" });
  const fresh = makeSession({ id: "fresh", cwd: "/X", projectRoot: "/X", modified: "2026-06-01T00:00:00.000Z" });
  const [g] = groupByProject([old, fresh, mid]);
  assert.equal(g.latestModified, "2026-06-01T00:00:00.000Z");
});

test("groupByProject: running and unread sets are projected per-group", () => {
  const a = makeSession({ id: "a", cwd: "/A", projectRoot: "/A" });
  const b = makeSession({ id: "b", cwd: "/B", projectRoot: "/B" });
  const running = new Set(["a"]);
  const unread = new Set(["b"]);
  const groups = groupByProject([a, b], { runningIds: running, unreadIds: unread });
  const aGroup = groups.find((g) => g.projectRoot === "/A");
  const bGroup = groups.find((g) => g.projectRoot === "/B");
  assert.equal(aGroup.runningIds.has("a"), true);
  assert.equal(aGroup.runningIds.size, 1);
  assert.equal(aGroup.unreadIds.size, 0);
  assert.equal(bGroup.unreadIds.has("b"), true);
  assert.equal(bGroup.runningIds.size, 0);
});

test("groupByProject: worktree branches deduped and sorted", () => {
  const a = makeSession({ id: "a", cwd: "/repo", projectRoot: "/repo", worktreeBranch: "main" });
  const b = makeSession({ id: "b", cwd: "/repo-wt/feat", projectRoot: "/repo", worktreeBranch: "feat" });
  const c = makeSession({ id: "c", cwd: "/repo-wt/main", projectRoot: "/repo", worktreeBranch: "main" });
  const [g] = groupByProject([a, b, c]);
  assert.deepEqual(g.branches, ["feat", "main"]);
});

test("groupByProject: displayName is basename of projectRoot", () => {
  const a = makeSession({ id: "a", cwd: "/x/y/pi-web", projectRoot: "/x/y/pi-web" });
  const [g] = groupByProject([a]);
  assert.equal(g.displayName, "pi-web");
});

test("groupByProject: trailing slashes do not break basename", () => {
  const a = makeSession({ id: "a", cwd: "/x/y/pi-web/", projectRoot: "/x/y/pi-web/" });
  const [g] = groupByProject([a]);
  assert.equal(g.displayName, "pi-web");
});

test("groupByProject: root '/' falls back to full path", () => {
  const a = makeSession({ id: "a", cwd: "/", projectRoot: "/" });
  const [g] = groupByProject([a]);
  assert.equal(g.displayName, "/");
});

test("findProjectForSession: returns owning group", () => {
  const a = makeSession({ id: "a", cwd: "/A", projectRoot: "/A" });
  const b = makeSession({ id: "b", cwd: "/B", projectRoot: "/B" });
  const groups = groupByProject([a, b]);
  const found = findProjectForSession(groups, "b");
  assert.ok(found);
  assert.equal(found.projectRoot, "/B");
});

test("findProjectForSession: returns null for unknown id", () => {
  const a = makeSession({ id: "a", cwd: "/A", projectRoot: "/A" });
  const groups = groupByProject([a]);
  assert.equal(findProjectForSession(groups, "nope"), null);
});
