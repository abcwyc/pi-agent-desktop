import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
// The gear menu itself is fork-owned and lives outside ChatInput.
const menuSource = readFileSync(new URL("./SessionAutomationMenu.tsx", import.meta.url), "utf8");

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function render(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
        onSetAutomation() {},
        ...props,
      }),
    ),
  );
}

const knownAutomation = {
  autoCompactionEnabled: true,
  autoRetryEnabled: false,
  steeringMode: "all",
  followUpMode: "one-at-a-time",
};

test("automation gear exposes the four session-automation controls", () => {
  const html = render({ automation: knownAutomation });
  assert.match(html, /aria-label="Session automation"/);
  // Popover content renders in static markup (server render has no toggle state,
  // so assert the controls' labels exist inside the source popover markup).
  assert.match(menuSource, /t\("chat\.autoCompaction"\)/);
  assert.match(menuSource, /t\("chat\.autoRetry"\)/);
  assert.match(menuSource, /onSetAutomation\(\{ autoCompaction: e\.target\.checked \}\)/);
  assert.match(menuSource, /onSetAutomation\(\{ autoRetry: e\.target\.checked \}\)/);
  assert.match(menuSource, /onSetAutomation\(\{ steeringMode: mode \}\)/);
  assert.match(menuSource, /onSetAutomation\(\{ followUpMode: mode \}\)/);
});

test("automation gear stays hidden while values are unknown (new session)", () => {
  const html = render({ automation: { autoCompactionEnabled: null, autoRetryEnabled: null, steeringMode: null, followUpMode: null } });
  assert.doesNotMatch(html, /aria-label="Session automation"/);
});

test("server supports the automation command set end to end", () => {
  const rpc = readFileSync(new URL("../lib/rpc-manager.ts", import.meta.url), "utf8");
  for (const cmd of ["set_auto_compaction", "set_auto_retry", "set_steering_mode", "set_follow_up_mode", "abort_retry"]) {
    assert.match(rpc, new RegExp(`case "${cmd}"`), cmd);
  }
  assert.match(rpc, /steeringMode: this\.inner\.steeringMode/);
  assert.match(rpc, /followUpMode: this\.inner\.followUpMode/);
  const hook = readFileSync(new URL("../hooks/useSessionAutomation.ts", import.meta.url), "utf8");
  assert.match(hook, /type: "set_auto_compaction", enabled: change\.autoCompaction/);
  assert.match(hook, /type: "set_steering_mode", mode: change\.steeringMode/);
});

test("narrow screens keep Stop one tap away while streaming", () => {
  const html = render({ isStreaming: true });
  assert.equal((html.match(/data-action="stop"/g) ?? []).length, 1);
  assert.ok(html.indexOf('data-action="stop"') < html.indexOf('class="chat-composer-controls"'), "Stop stays in the editor, outside collapsed controls");
  assert.match(html, /aria-label="Stop agent"/);
  assert.doesNotMatch(html, /composer-stop-button/);
});

test("tool preset control dims instead of vanishing while streaming", () => {
  const idx = source.indexOf("{onToolPresetChange && (");
  assert.ok(idx !== -1);
  assert.doesNotMatch(source.slice(idx, idx + 60), /!isStreaming/);
});
