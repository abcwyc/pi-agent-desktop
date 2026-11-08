import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./[id]/entries/[entryId]/tool-result-image/route.ts");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("../../../lib/session-reader.ts");

// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a tool result image is served once and then cached for good", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tool-image-"));
  const id = "tool-image-route-test";
  const filePath = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const timestamp = "2026-01-01T00:00:00.000Z";
  await writeFile(filePath, [
    { type: "session", version: 3, id, timestamp, cwd: dir },
    { type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: "shot", timestamp: 1 } },
    {
      type: "message", id: "r1", parentId: "u1", timestamp,
      message: { role: "toolResult", toolCallId: "c1", toolName: "read", isError: false, timestamp: 2, content: [
        { type: "text", text: "Read image" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ] },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  cacheSessionPath(id, filePath);
  t.after(async () => {
    invalidateSessionPathCache(id);
    await rm(dir, { recursive: true, force: true });
  });

  const response = await GET(
    new Request(`http://localhost/api/sessions/${id}/entries/r1/tool-result-image?blockIndex=1`),
    { params: Promise.resolve({ id, entryId: "r1" }) },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(response.headers.get("Cache-Control"), "private, max-age=31536000, immutable");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(PNG, "base64"));

  const missing = await GET(
    new Request(`http://localhost/api/sessions/${id}/entries/r1/tool-result-image?blockIndex=0`),
    { params: Promise.resolve({ id, entryId: "r1" }) },
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("Cache-Control")?.includes("immutable") ?? false, false);
});
