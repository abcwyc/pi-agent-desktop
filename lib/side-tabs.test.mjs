import assert from "node:assert/strict";
import test from "node:test";
import { addSideTab, pruneSideTabs, readSideTabs, writeSideTabs } from "./side-tabs.ts";

test("side tabs survive a reload and ignore what does not parse (C1)", () => {
  const tabs = [{ sessionId: "s1", parentId: "p" }, { sessionId: "s2", parentId: "q" }];
  assert.deepEqual(readSideTabs(writeSideTabs(tabs)), tabs);
  assert.equal(writeSideTabs([]), null);
  assert.deepEqual(readSideTabs("{"), []);
  assert.deepEqual(readSideTabs('[{"sessionId":"s1"},{"sessionId":"s1","parentId":"p"},{"sessionId":"s1","parentId":"x"}]'), [{ sessionId: "s1", parentId: "p" }]);
});

test("a tab is added once", () => {
  const tabs = addSideTab([], { sessionId: "s1", parentId: "p" });
  assert.deepEqual(addSideTab(tabs, { sessionId: "s1", parentId: "p" }), tabs);
  assert.equal(addSideTab(tabs, { sessionId: "s2", parentId: "p" }).length, 2);
});

test("a deleted side chat's tab goes; a just-forked one waits for the catalog", () => {
  const tabs = [{ sessionId: "gone", parentId: "p" }, { sessionId: "new", parentId: "p" }, { sessionId: "other", parentId: "elsewhere" }];
  const catalog = new Set(["p"]);
  // "gone" was listed before; "new" never was; "other"'s parent is not loaded.
  assert.deepEqual(pruneSideTabs(tabs, catalog, new Set(["gone"])).map((tab) => tab.sessionId), ["new", "other"]);
  const unchanged = pruneSideTabs(tabs, new Set(["p", "gone", "new"]), new Set());
  assert.equal(unchanged, tabs, "no change keeps the same array, so state does not churn");
});
