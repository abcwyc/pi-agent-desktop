import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AgentSessionPanel.tsx", import.meta.url), "utf8");

test("keeps the main session first and makes every agent session selectable", () => {
  const mainRow = source.indexOf("session={rootSession}");
  const subagentRows = source.indexOf("visibleSubagents.map");
  assert.ok(mainRow > 0);
  assert.ok(subagentRows > mainRow);
  assert.match(source, /onSelect=\{\(\) => onSelectSession\(rootSession\)\}/);
  assert.match(source, /onSelect=\{\(\) => onSelectSession\(session\)\}/);
  assert.match(source, /aria-selected=\{selected\}/);
});

test("sorts running subagents first and enables search only for larger families", () => {
  assert.match(source, /if \(aRunning !== bRunning\) return aRunning \? -1 : 1/);
  assert.match(source, /subagents\.length > 8/);
  assert.match(source, /relation\?\.description, relation\?\.profile, session\.name, session\.firstMessage/);
  assert.match(source, /maxHeight: "min\(58dvh, 480px\)"/);
});

test("renders as a compact left-positioned dropdown without a centered inner width", () => {
  assert.match(source, /borderLeft: "var\(--hairline\) solid var\(--border\)"/);
  assert.match(source, /borderRadius: "0 0 6px 6px"/);
  assert.doesNotMatch(source, /maxWidth: 680/);
});

test("shows persisted completion states while live running state takes precedence", () => {
  assert.match(source, /const status: SubagentSessionStatus = running \? "running" : relation\?\.status \?\? "completed"/);
  assert.match(source, /t\(`agentSwitcher\.status\.\$\{status\}`\)/);
  assert.match(source, /status === "failed"/);
  assert.match(source, /status === "aborted" \|\| status === "interrupted"/);
});

test("running sub-agents expose steer and stop controls wired to the runtime route", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
  const React = await jiti.import("react");
  const { renderToStaticMarkup } = await jiti.import("react-dom/server");
  const { AgentSessionPanel } = await jiti.import("./AgentSessionPanel.tsx");
  const { I18nProvider } = await jiti.import("@/hooks/useI18n");

  const root = { id: "main", name: "main", firstMessage: "", modified: "2026-01-01T00:00:00Z" };
  const runningSub = { id: "sub1", name: null, firstMessage: "task", modified: "2026-01-01T00:00:00Z", relation: { kind: "subagent", status: "running", profile: "researcher", description: "research" } };
  const doneSub = { id: "sub2", name: null, firstMessage: "done task", modified: "2026-01-01T00:00:00Z", relation: { kind: "subagent", status: "completed", profile: "researcher", description: "done" } };

  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(AgentSessionPanel, {
      rootSession: root,
      subagents: [runningSub, doneSub],
      selectedSessionId: "main",
      runningSessionIds: new Set(["sub1"]),
      onSelectSession() {},
    })));

  const runningRow = html.slice(html.indexOf("sub1") !== -1 ? html.indexOf("research") : 0);
  assert.match(html, /aria-label="Stop sub-agent"/);
  assert.match(html, /aria-label="Steer sub-agent"/);
  // Completed sub-agent rows carry no controls: count total stop buttons == running count.
  assert.equal((html.match(/aria-label="Stop sub-agent"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-label="Steer sub-agent"/g) ?? []).length, 1);
  assert.ok(runningRow.length > 0);
});

test("control actions POST to the subagent runtime endpoint", () => {
  assert.match(source, /\/api\/subagents\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(source, /action: "abort" | "steer"/);
  assert.match(source, /JSON\.stringify\(\{ action, message \}\)/);
});
