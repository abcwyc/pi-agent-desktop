import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalDir = process.env.PI_CODING_AGENT_DIR;
const dir = await mkdtemp(join(tmpdir(), "pi-appearance-test-"));
process.env.PI_CODING_AGENT_DIR = dir;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, PUT } = await jiti.import("./route.ts");
const file = join(dir, "pi-web", "settings.json");
after(async () => {
  if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalDir;
  await rm(dir, { recursive: true, force: true });
});
const request = (body, headers = {}) => new Request("http://localhost/api/appearance", {
  method: "PUT", headers: { Host: "localhost", "Content-Type": "application/json", ...headers }, body,
});

test("persists backgrounds without altering unrelated Pi Web settings", async () => {
  assert.deepEqual(await (await GET()).json(), { background: null });
  await mkdir(join(dir, "pi-web"), { recursive: true });
  await writeFile(file, JSON.stringify({ artifactsPrompt: false, other: { enabled: true } }));
  for (const background of ["rex", "mist", "meadow", "dusk", "plain"]) {
    const response = await PUT(request(JSON.stringify({ background })));
    assert.equal(response.status, 200);
    assert.deepEqual(await (await GET()).json(), { background });
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(stored.artifactsPrompt, false);
    assert.deepEqual(stored.other, { enabled: true });
  }
});

test("rejects untrusted, malformed and invalid saves without changing the file", async () => {
  const before = await readFile(file, "utf8");
  for (const [body, headers, status] of [
    ['{"background":"mist"}', { Origin: "https://untrusted.example" }, 403],
    ['{"background":"mist"}', { "Content-Type": "text/plain" }, 415],
    ["{", {}, 400], ["null", {}, 400], ['{"background":"unknown"}', {}, 400],
  ]) {
    assert.equal((await PUT(request(body, headers))).status, status);
    assert.equal(await readFile(file, "utf8"), before);
  }
});

test("a damaged settings file is reported and cannot be overwritten", async () => {
  await writeFile(file, "{damaged");
  assert.equal((await GET()).status, 500);
  assert.equal((await PUT(request('{"background":"mist"}'))).status, 500);
  assert.equal(await readFile(file, "utf8"), "{damaged");
});
