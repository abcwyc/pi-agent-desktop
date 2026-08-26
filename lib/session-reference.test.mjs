import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./session-reference.ts");
}

test("extracts unique visible session labels", async () => {
  const { extractSessionReferenceLabels } = await loadSubject();
  assert.deepEqual(
    extractSessionReferenceLabels("Compare #Design with #\"Design review\" and #Design"),
    ["Design", "Design review"],
  );
});

function stubFetch(sessions, references) {
  return async (url) => {
    if (url === "/api/sessions") {
      return { ok: true, json: async () => ({ sessions }) };
    }
    const match = /^\/api\/sessions\/([^/]+)\/reference$/.exec(url);
    if (match) {
      const id = decodeURIComponent(match[1]);
      return references[id] !== undefined
        ? { ok: true, json: async () => ({ reference: references[id] }) }
        : { ok: false, json: async () => ({ error: "not found" }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

test("bare #token matching a session name is kept as typed without panel confirmation", async () => {
  const { resolveSessionReferences } = await loadSubject();
  const fetchImpl = stubFetch(
    [{ id: "s-1", name: "include", firstMessage: "about include", cwd: "/x" }],
    {},
  );
  const message = "use #include for the header";
  const result = await resolveSessionReferences(message, new Map(), fetchImpl);
  assert.equal(result, message);
});

test("bare #token expands when the user picked the target from the mention panel", async () => {
  const { resolveSessionReferences } = await loadSubject();
  const fetchImpl = stubFetch([], { "s-1": "<referenced-session id=\"s-1\">…</referenced-session>" });
  const result = await resolveSessionReferences(
    "see #Design for context",
    new Map([["Design", "s-1"]]),
    fetchImpl,
  );
  assert.equal(result, "see <referenced-session id=\"s-1\">…</referenced-session> for context");
});

test("quoted #\"name\" resolves by name without panel confirmation", async () => {
  const { resolveSessionReferences } = await loadSubject();
  const fetchImpl = stubFetch(
    [{ id: "s-2", name: "Design review", firstMessage: "review", cwd: "/x" }],
    { "s-2": "<referenced-session id=\"s-2\">…</referenced-session>" },
  );
  const result = await resolveSessionReferences('compare #"Design review"', new Map(), fetchImpl);
  assert.equal(result, "compare <referenced-session id=\"s-2\">…</referenced-session>");
});

test("unresolvable tokens stay as typed", async () => {
  const { resolveSessionReferences } = await loadSubject();
  const fetchImpl = stubFetch([], {});
  const message = "check #42 and #\"nope\"";
  const result = await resolveSessionReferences(message, new Map(), fetchImpl);
  assert.equal(result, message);
});

test("bare and quoted tokens mix: only confirmed/quoted expand", async () => {
  const { resolveSessionReferences } = await loadSubject();
  const fetchImpl = stubFetch(
    [{ id: "s-3", name: "region", firstMessage: "region", cwd: "/x" }],
    { "s-3": "REF-REGION", "s-4": "REF-PICKED" },
  );
  const message = "#region and #picked";
  const result = await resolveSessionReferences(message, new Map([["picked", "s-4"]]), fetchImpl);
  assert.equal(result, "#region and REF-PICKED");
});
