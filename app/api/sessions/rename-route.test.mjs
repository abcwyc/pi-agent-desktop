// PATCH /api/sessions/[id] renames through the live session's own manager
// whenever one is alive, so the detail GET (which reads that manager) and later
// appends see the new name. Only a session with no live wrapper is renamed on disk.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-rename-")));
after(() => rmSync(home, { recursive: true, force: true }));
process.env.PI_AGENT_HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
const sessionsDir = join(home, ".pi", "agent", "sessions", "--rename-fixture--");
mkdirSync(sessionsDir, { recursive: true });

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET, PATCH } = await jiti.import("./[id]/route.ts");

function flushedSession(name) {
  const manager = SessionManager.create(home, sessionsDir);
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop", timestamp: 2 });
  manager.appendSessionInfo(name);
  return manager;
}

function register(manager) {
  const id = manager.getSessionId();
  const wrapper = {
    sessionFile: manager.getSessionFile(),
    isAlive: () => true,
    isRunning: () => false,
    evictIfDiskAhead: () => false,
    inner: { sessionManager: manager, setSessionName: (name) => manager.appendSessionInfo(name) },
  };
  globalThis.__piSessions ??= new Map();
  globalThis.__piSessions.set(id, wrapper);
  after(() => globalThis.__piSessions.delete(id));
  return id;
}

const rename = (id, name) => PATCH(
  new Request(`http://localhost/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  { params: Promise.resolve({ id }) },
);
const detailName = async (id) => {
  const response = await GET(new Request(`http://localhost/api/sessions/${id}`), { params: Promise.resolve({ id }) });
  return (await response.json()).info?.name;
};

test("renaming a live, flushed session updates the live manager, the detail and the file", async () => {
  const manager = flushedSession("Old title");
  const id = register(manager);

  const response = await rename(id, "  New title ");
  assert.equal(response.status, 200);
  assert.equal(manager.getSessionName(), "New title");
  assert.equal(await detailName(id), "New title");
  assert.equal(SessionManager.open(manager.getSessionFile()).getSessionName(), "New title");

  // The name sits on the live branch, so the next entry follows it instead of forking around it.
  const nameEntry = manager.getLeafEntry();
  assert.equal(nameEntry.type, "session_info");
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "again" }], timestamp: 3 });
  assert.equal(manager.getLeafEntry().parentId, nameEntry.id);
});

test("an empty name clears a live session's title", async () => {
  const manager = flushedSession("Old title");
  const id = register(manager);
  assert.equal((await rename(id, "")).status, 200);
  assert.equal(manager.getSessionName(), undefined);
});

test("without a live wrapper the name is written to the file", async () => {
  const manager = flushedSession("Old title");
  const id = manager.getSessionId();
  assert.equal((await rename(id, "On disk")).status, 200);
  assert.equal(SessionManager.open(manager.getSessionFile()).getSessionName(), "On disk");
});
