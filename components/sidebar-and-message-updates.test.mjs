import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidebarSource = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const messageSource = readFileSync(new URL("./MessageView.tsx", import.meta.url), "utf8");

test("session rows keep the action menu reachable on touch devices", () => {
  assert.match(sidebarSource, /matchMedia\?\.\("\(hover: none\)"\)/);
  assert.match(sidebarSource, /hovered \|\| touchMode \|\| menuOpen \?/);
});

test("rename and delete failures surface an error instead of being swallowed", () => {
  assert.match(sidebarSource, /sidebar\.renameFailed/);
  assert.match(sidebarSource, /sidebar\.deleteFailed/);
  assert.match(sidebarSource, /role="alert"/);
  assert.doesNotMatch(sidebarSource, /\/\* ignore \*\//);
});

test("interrupted tool calls render a cancelled marker instead of success styling", () => {
  // Loaded (non-streaming) message + no paired result ⇒ aborted.
  assert.match(messageSource, /aborted=\{!isStreaming && !result\}/);
  assert.match(messageSource, /t\("chat\.toolCancelled"\)/);
  // Aborted styling is neutral slate, distinct from the green success border.
  assert.match(messageSource, /rgba\(148,163,184,0\.4\)/);
});
