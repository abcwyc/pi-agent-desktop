import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ExtensionStatusLine, formatExtensionStatusLine } = await jiti.import("./ExtensionStatusLine.tsx");

const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");

test("orders statuses by key and folds each to one line", () => {
  assert.equal(
    formatExtensionStatusLine([
      { key: "b", text: "tokens\n 12k" },
      { key: "a", text: "git main" },
      { key: "c", text: "\u001b[2m \u001b[0m" },
    ]),
    "git main  tokens 12k",
  );
});

test("renders nothing when every status is blank", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionStatusLine, { statuses: [{ key: "a", text: "  " }] }));
  assert.equal(html, "");
});

test("renders the status text with the plain text as tooltip", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionStatusLine, {
    statuses: [{ key: "a", text: "\u001b[32mready\u001b[0m" }],
  }));
  assert.match(html, /role="status"/);
  assert.match(html, /title="ready"/);
});

test("ctx.ui.setStatus reaches the shelf under the composer", () => {
  // The hook must apply setStatus requests and every get_state snapshot; the component
  // was once removed and the state left dangling, so statuses were silently dropped.
  assert.match(hookSource, /case "setStatus":\s*setExtensionStatuses\(/);
  assert.match(hookSource, /\.extensionStatuses !== undefined\) setExtensionStatuses\(/);
  assert.match(chatWindowSource, /\{hasExtensionStatus && <ExtensionStatusLine statuses=\{extensionStatuses\} \/>\}/);
});

test("follows a session an extension command moved to", () => {
  assert.match(hookSource, /case "session_replaced":[\s\S]*?onSessionForked\?\.\(event\.sessionId\)/);
});
