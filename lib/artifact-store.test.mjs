import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactTitlesKey,
  getSessionArtifact,
  hasArtifactOpener,
  openArtifact,
  publishSessionArtifacts,
  requestArtifactFix,
  requestArtifactPrompt,
  resetArtifactStore,
  setArtifactFixHandler,
  setArtifactPromptHandler,
  setActiveArtifactSession,
  setArtifactOpener,
  subscribeArtifacts,
} from "./artifact-store.ts";

const entry = (identifier, ...contents) => ({
  identifier,
  versions: contents.map((content) => ({ title: identifier, type: "html", lang: "html", content, complete: true })),
});

test("keeps identity for unchanged artifacts and only notifies on change", () => {
  resetArtifactStore();
  let notified = 0;
  const unsubscribe = subscribeArtifacts(() => { notified += 1; });

  publishSessionArtifacts("s1", [entry("a", "one")]);
  const first = getSessionArtifact("s1", "a");
  assert.equal(notified, 1);

  publishSessionArtifacts("s1", [entry("a", "one")]);
  assert.equal(getSessionArtifact("s1", "a"), first);
  assert.equal(notified, 1);

  publishSessionArtifacts("s1", [entry("a", "one", "two")]);
  assert.notEqual(getSessionArtifact("s1", "a"), first);
  assert.equal(getSessionArtifact("s1", "a").versions.length, 2);
  assert.equal(notified, 2);
  unsubscribe();
});

test("routes open requests to the registered opener for the active session", () => {
  resetArtifactStore();
  const requests = [];
  assert.equal(openArtifact({ identifier: "a", title: "A" }), false);

  const cleanup = setArtifactOpener((request) => requests.push(request));
  assert.equal(openArtifact({ identifier: "a", title: "A" }), false, "no active session");

  setActiveArtifactSession("s1");
  assert.equal(openArtifact({ identifier: "a", title: "A", version: 2 }), true);
  assert.deepEqual(requests, [{ identifier: "a", title: "A", version: 2, sessionId: "s1" }]);

  cleanup();
  assert.equal(openArtifact({ identifier: "a", title: "A" }), false);
});

test("sends fix requests only to the session that registered the handler", () => {
  resetArtifactStore();
  const sent = [];
  assert.equal(requestArtifactFix("s1", "fix"), false);
  const cleanup = setArtifactFixHandler("s1", (text) => sent.push(text));
  assert.equal(requestArtifactFix("s2", "other"), false);
  assert.equal(requestArtifactFix("s1", "fix it"), true);
  assert.deepEqual(sent, ["fix it"]);
  cleanup();
  assert.equal(requestArtifactFix("s1", "late"), false);
});

test("tells subscribers when the panel opener comes and goes", () => {
  resetArtifactStore();
  let notified = 0;
  const unsubscribe = subscribeArtifacts(() => { notified += 1; });
  const cleanup = setArtifactOpener(() => {});
  assert.equal(hasArtifactOpener(), true);
  assert.equal(notified, 1);
  cleanup();
  assert.equal(hasArtifactOpener(), false);
  assert.equal(notified, 2);
  unsubscribe();
});

test("the tab-title key changes only when a title does", () => {
  resetArtifactStore();
  const refs = [{ sessionId: "s", identifier: "a" }];
  const version = (title, content) => ({ title, type: "html", lang: "html", content, complete: false });
  publishSessionArtifacts("s", [{ identifier: "a", versions: [version("Calc", "<p>1")] }]);
  const first = artifactTitlesKey(refs);
  publishSessionArtifacts("s", [{ identifier: "a", versions: [version("Calc", "<p>1<p>2")] }]);
  assert.equal(artifactTitlesKey(refs), first, "a streamed chunk keeps the key");
  publishSessionArtifacts("s", [{ identifier: "a", versions: [version("Tip calculator", "<p>1<p>2")] }]);
  assert.notEqual(artifactTitlesKey(refs), first);
});

test("a preview's prompt reaches only the session whose composer registered, and never sends", () => {
  resetArtifactStore();
  const inserted = [];
  const sent = [];
  const offFix = setArtifactFixHandler("a", (text) => sent.push(text));
  const off = setArtifactPromptHandler("a", (text) => inserted.push(text));
  assert.equal(requestArtifactPrompt("a", "Break down step 2"), true);
  assert.equal(requestArtifactPrompt("b", "other conversation"), false);
  assert.equal(requestArtifactPrompt(null, "no session"), false);
  assert.deepEqual(inserted, ["Break down step 2"]);
  assert.deepEqual(sent, []);
  off();
  offFix();
  assert.equal(requestArtifactPrompt("a", "after cleanup"), false);
});

test("a newer prompt handler replaces the old one, and the old cleanup leaves the new one alone", () => {
  resetArtifactStore();
  const first = [];
  const second = [];
  const offFirst = setArtifactPromptHandler("a", (text) => first.push(text));
  setArtifactPromptHandler("a", (text) => second.push(text));
  offFirst();
  assert.equal(requestArtifactPrompt("a", "x"), true);
  assert.deepEqual([first, second], [[], ["x"]]);
  resetArtifactStore();
  assert.equal(requestArtifactPrompt("a", "y"), false);
});
