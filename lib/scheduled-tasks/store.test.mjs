import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const store = await createJiti(import.meta.url).import("./store.ts");

function agentDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-sched-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const task = (n, extra = {}) => ({
  id: id(n), name: `task ${n}`, prompt: "p", cwd: "/", schedule: { kind: "manual" },
  toolPreset: "read-only", maxDurationMin: 30, enabled: true,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", consecutiveFailures: 0, ...extra,
});
const add = (dir, t) => store.mutateTasks((tasks) => ({ tasks: [...tasks, t], result: t }), dir);

test("an absent file reads as no tasks", (t) => {
  assert.deepEqual(store.listTasks(agentDir(t)), []);
});

test("tasks round-trip and the file is versioned", (t) => {
  const dir = agentDir(t);
  add(dir, task(1));
  add(dir, task(2));
  assert.deepEqual(store.listTasks(dir).map((x) => x.id), [id(1), id(2)]);
  assert.equal(JSON.parse(readFileSync(store.scheduledTasksFile(dir), "utf8")).version, 1);
});

test("unknown top-level fields, unknown task fields and unreadable entries survive a write", (t) => {
  const dir = agentDir(t);
  writeFileSync(store.scheduledTasksFile(dir), JSON.stringify({
    version: 1, futureSetting: { a: 1 },
    tasks: [task(1, { futureField: "keep me" }), { id: "not-a-uuid", from: "a newer build" }],
  }));
  store.updateTask(id(1), (x) => ({ ...x, name: "renamed" }), dir);
  const written = JSON.parse(readFileSync(store.scheduledTasksFile(dir), "utf8"));
  assert.deepEqual(written.futureSetting, { a: 1 });
  assert.ok(written.tasks.some((x) => x.from === "a newer build"));
  const kept = written.tasks.find((x) => x.id === id(1));
  assert.equal(kept.futureField, "keep me");
  assert.equal(kept.name, "renamed");
});

test("a damaged file throws rather than reading as empty", (t) => {
  const dir = agentDir(t);
  writeFileSync(store.scheduledTasksFile(dir), "{ not json");
  assert.throws(() => store.listTasks(dir));
  assert.throws(() => add(dir, task(1)));
  assert.equal(readFileSync(store.scheduledTasksFile(dir), "utf8"), "{ not json");
});

test("updateTask and deleteTask report whether the task existed", (t) => {
  const dir = agentDir(t);
  add(dir, task(1));
  assert.equal(store.updateTask(id(9), (x) => x, dir), undefined);
  assert.equal(store.deleteTask(id(9), {}, dir), false);
  assert.equal(store.deleteTask(id(1), {}, dir), true);
  assert.deepEqual(store.listTasks(dir), []);
});

const run = (n, extra = {}) => ({ runId: `run-${n}`, taskId: id(1), trigger: "manual", status: "running", ...extra });

test("runs append, update in place and list oldest first", (t) => {
  const dir = agentDir(t);
  store.appendRun(run(1), dir);
  store.appendRun(run(2), dir);
  store.updateRun(id(1), "run-1", (r) => ({ ...r, status: "succeeded" }), dir);
  const runs = store.listRuns(id(1), dir);
  assert.deepEqual(runs.map((r) => [r.runId, r.status]), [["run-1", "succeeded"], ["run-2", "running"]]);
  assert.equal(store.updateRun(id(1), "nope", (r) => r, dir), undefined);
});

test("history is capped at 200 runs per task", (t) => {
  const dir = agentDir(t);
  for (let i = 0; i < 205; i += 1) store.appendRun(run(i), dir);
  const runs = store.listRuns(id(1), dir);
  assert.equal(runs.length, 200);
  assert.equal(runs[0].runId, "run-5");
  assert.equal(runs.at(-1).runId, "run-204");
});

test("a run pushed out of the history still marks its session as a scheduled run", (t) => {
  const dir = agentDir(t);
  for (let i = 0; i < 205; i += 1) store.appendRun(run(i, { sessionId: `s${i}` }), dir);
  assert.equal(store.listRuns(id(1), dir).length, 200, "the visible history stays capped");
  const sessions = new Set(store.listAllRuns(dir).map((r) => r.sessionId));
  assert.equal(sessions.size, 205, "every session, old and new, is still known");
  for (let i = 0; i < 205; i += 1) assert.ok(sessions.has(`s${i}`), `s${i}`);
});

test("runs without a session leave nothing in the archive, and deleting the task removes it", (t) => {
  const dir = agentDir(t);
  add(dir, task(1));
  for (let i = 0; i < 203; i += 1) store.appendRun(run(i, i < 3 ? {} : { sessionId: `s${i}` }), dir);
  const archive = join(dir, "scheduled-tasks", "runs", `${id(1)}.archive.jsonl`);
  assert.equal(existsSync(archive), false, "the three dropped runs had no session");

  for (let i = 203; i < 210; i += 1) store.appendRun(run(i, { sessionId: `s${i}` }), dir);
  assert.equal(existsSync(archive), true);
  store.deleteTask(id(1), { removeRuns: true }, dir);
  assert.equal(existsSync(archive), false);
  assert.deepEqual(store.listAllRuns(dir), []);
});

test("a torn line in the runs file does not hide the others", (t) => {
  const dir = agentDir(t);
  store.appendRun(run(1), dir);
  const file = join(dir, "scheduled-tasks", "runs", `${id(1)}.jsonl`);
  writeFileSync(file, `${readFileSync(file, "utf8")}{"runId":"torn\n`);
  assert.deepEqual(store.listRuns(id(1), dir).map((r) => r.runId), ["run-1"]);
});

test("a task id that is not a uuid cannot reach the filesystem", (t) => {
  const dir = agentDir(t);
  assert.throws(() => store.listRuns("../../etc/passwd", dir), /Invalid task id/);
  assert.throws(() => store.appendRun({ ...run(1), taskId: "../x" }, dir), /Invalid task id/);
});

test("deleting a task removes its history only on request", (t) => {
  const dir = agentDir(t);
  add(dir, task(1));
  store.appendRun(run(1), dir);
  const file = join(dir, "scheduled-tasks", "runs", `${id(1)}.jsonl`);
  store.deleteTask(id(1), {}, dir);
  assert.equal(existsSync(file), true);
  add(dir, task(1));
  store.deleteTask(id(1), { removeRuns: true }, dir);
  assert.equal(existsSync(file), false);
});

test("listAllRuns gathers every task's runs", (t) => {
  const dir = agentDir(t);
  store.appendRun(run(1), dir);
  store.appendRun({ ...run(2), taskId: id(2) }, dir);
  assert.deepEqual(store.listAllRuns(dir).map((r) => r.runId).sort(), ["run-1", "run-2"]);
});
