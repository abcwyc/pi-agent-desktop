import assert from "node:assert/strict";
import test from "node:test";

const frames = await import("./frames.ts");
const { FrameType } = frames;

test("frames round-trip type, stream and payload", () => {
  const payload = Uint8Array.of(1, 2, 3);
  const decoded = frames.decodeFrame(frames.encodeFrame(FrameType.ResponseBody, 0xfffffffe, payload));
  assert.equal(decoded.type, FrameType.ResponseBody);
  assert.equal(decoded.stream, 0xfffffffe);
  assert.deepEqual(decoded.payload, payload);
});

test("malformed frames are refused", () => {
  assert.throws(() => frames.decodeFrame(Uint8Array.of(1, 0, 0)));
  assert.throws(() => frames.decodeFrame(Uint8Array.of(99, 0, 0, 0, 1)));
  assert.throws(() => frames.encodeFrame(FrameType.RequestBody, 1, new Uint8Array(frames.MAX_FRAME_PAYLOAD + 1)));
  assert.throws(() => frames.encodeFrame(FrameType.RequestBody, -1));
});

test("bodies split into frame-sized chunks and reassemble", () => {
  const body = new Uint8Array(frames.MAX_FRAME_PAYLOAD * 2 + 10).map((_, i) => i % 251);
  const chunks = [...frames.chunkBody(body)];
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((c) => c.length <= frames.MAX_FRAME_PAYLOAD));
  assert.deepEqual(Uint8Array.from(chunks.flatMap((c) => [...c])), body);
  assert.equal([...frames.chunkBody(new Uint8Array(0))].length, 0);
});

test("request heads only name paths on the desktop's own server", () => {
  const head = (value) => frames.parseRequestHead(frames.encodeJson(value));
  assert.deepEqual(head({ method: "GET", url: "/api/x?a=1", headers: [["accept", "*/*"]] }),
    { method: "GET", url: "/api/x?a=1", headers: [["accept", "*/*"]] });
  for (const url of ["http://evil.example/", "//evil.example/x", "api/x", "", "/".repeat(9000)]) {
    assert.equal(head({ method: "GET", url, headers: [] }), null, url);
  }
  assert.equal(head({ method: "get", url: "/", headers: [] }), null);
  assert.equal(head({ method: "GET", url: "/", headers: [["a"]] }), null);
  assert.equal(frames.parseRequestHead(new TextEncoder().encode("{not json")), null);
});

test("response heads need a real status", () => {
  const head = (value) => frames.parseResponseHead(frames.encodeJson(value));
  assert.deepEqual(head({ status: 200, headers: [] }), { status: 200, headers: [] });
  assert.equal(head({ status: 42, headers: [] }), null);
  assert.equal(head({ status: 200 }), null);
});
