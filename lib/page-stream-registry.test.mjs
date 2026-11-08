import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { listPageStreams, pageStreamLabel, registerPageStream } = await jiti.import("./page-stream-registry.ts");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

test("a stream's label: its page from ?holder=, its client from the headers", () => {
  const request = new Request("http://localhost/api/terminal/t1/events?holder=mvth86th-nw4hseqy&after=4", {
    headers: { "x-forwarded-for": "192.168.32.6", "user-agent": UA },
  });
  assert.deepEqual(pageStreamLabel("terminal", request), {
    kind: "terminal",
    holder: "mvth86th-nw4hseqy",
    address: "192.168.32.6",
    client: "Chrome · Windows",
  });
  // An invalid page id is no page id.
  const odd = pageStreamLabel("file-watch", new Request("http://localhost/api/files/a?type=watch&holder=%3Cx%3E"));
  assert.equal(odd.holder, null);
});

test("listed until released, once however often the release runs", () => {
  const before = listPageStreams().length;
  const release = registerPageStream({ kind: "file-watch", holder: "page-1", address: null, client: null });
  assert.equal(listPageStreams().length, before + 1);
  release();
  release();
  assert.equal(listPageStreams().length, before);
});

