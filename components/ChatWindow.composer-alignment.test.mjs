import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const inputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("keeps the message scrollbar track so the column cannot move with content", () => {
  assert.match(
    source,
    /className="chat-scroll-container scrollbar-subtle min-w-0 flex-1 overflow-x-hidden overflow-y-scroll pt-4"/,
    "the message scrollport must always show its track, whether or not the session overflows yet",
  );
  // WebKit (the macOS desktop shell) does not reliably honour scrollbar-gutter,
  // so relying on it let the column jump sideways as a session loaded.
  assert.doesNotMatch(source, /\[scrollbar-gutter:stable\]/, "do not depend on scrollbar-gutter");
  assert.match(
    source,
    /paddingLeft: scrollbarGutter > 0 \? scrollbarGutter : undefined,/,
    "the scrollport mirrors its track on the left so the column centres on the full width",
  );
});

test("puts the composer column on the message column's axis", () => {
  const probe = source.slice(source.indexOf("ref={scrollbarGutterProbeRef}"));
  const probeTag = probe.slice(0, probe.indexOf("/>"));

  assert.match(probeTag, /aria-hidden="true"/, "the probe is decoration, not content");
  assert.match(probeTag, /pointer-events-none/);
  assert.match(probeTag, /opacity-0/, "the probe must never be visible");
  assert.match(probeTag, /overflow-y-scroll/, "the probe must force a track like the message list");

  assert.match(source, /const next = Math\.max\(0, probe\.offsetWidth - probe\.clientWidth\);/);
  assert.match(source, /setScrollbarGutter\(\(previous\) => \(previous === next \? previous : next\)\);/);
  assert.match(source, /new ResizeObserver\(measure\)/);
  assert.match(source, /window\.addEventListener\("resize", measure\)/);

  assert.match(
    source,
    /\.\.\.\(scrollbarGutter > 0 \? \{ paddingInline: scrollbarGutter \} : \{\}\)/,
    "the composer must be inset on both sides exactly like the message column",
  );
  assert.match(
    source,
    /right: isMobile \? 0 : CHAT_MINIMAP_WIDTH,\n              display: "flex",\n              justifyContent: "center",/,
    "the scroll-to-latest control must stay centred on the same column",
  );
});

test("the new-session screen has no header row above the composer", () => {
  // The fork dropped the icon + PRODUCT_NAME branding row and then the update
  // chip too, so nothing sits between the empty state and the composer.
  assert.doesNotMatch(source, /NewSessionUpdateLink/, "the update chip above the composer was removed");
  assert.doesNotMatch(source, /apple-touch-icon|PRODUCT_NAME/, "the product branding must not come back above the composer");
  assert.doesNotMatch(source, /\/api\/app-update/, "ChatWindow no longer checks for updates");
});

test("composer and message columns share one padding and one max width", () => {
  const columnPadding = Number(/const CHAT_COLUMN_PADDING = (\d+);/.exec(source)?.[1]);
  assert.ok(Number.isFinite(columnPadding), "CHAT_COLUMN_PADDING must be a number");

  const composerPadding = Number(/padding: compact \? 0 : "0 (\d+)px 8px"/.exec(inputSource)?.[1]);
  const widgetPadding = Number(/className="mb-2 w-full" style=\{\{ padding: "0 (\d+)px" \}\}/.exec(source)?.[1]);

  assert.equal(composerPadding, columnPadding, "the composer fieldset must inset the column like the message list");
  assert.equal(widgetPadding, columnPadding, "extension widgets must sit on the column axis");

  const maxWidth = "var(--chat-content-max-width, 820px)";
  assert.equal(
    source.split(maxWidth).length - 1,
    2,
    "message list and extension widgets share the appearance width",
  );
  assert.equal(inputSource.split(maxWidth).length - 1, 1, "the composer shares the appearance width");
});
