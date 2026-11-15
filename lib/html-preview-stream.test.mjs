import assert from "node:assert/strict";
import test from "node:test";
import {
  HTML_PREVIEW_STREAM_MESSAGE,
  HTML_PREVIEW_STREAM_MIN_CHARS,
  buildStreamShell,
  canStreamPreview,
} from "./html-preview-stream.ts";
import { HTML_PREVIEW_SANDBOX } from "./html-preview.ts";

test("only html and svg that can be drawn without their external styles stream", () => {
  const page = "<!doctype html><html><body><h1>Hello streaming</h1>";
  assert.equal(canStreamPreview("html", page), true);
  assert.equal(canStreamPreview("svg", '<svg viewBox="0 0 10 10"><rect width="4" height="4"/>'), true);
  assert.equal(canStreamPreview("react", "export default function App(){ return <div/> }"), false);
  assert.equal(canStreamPreview("html", "<!doctype"), false, "too short to draw");
  assert.equal(canStreamPreview("html", "x".repeat(HTML_PREVIEW_STREAM_MIN_CHARS - 1)), false);
  assert.equal(canStreamPreview("html", `${page}<script src="https://cdn.tailwindcss.com"></script>`), false);
  assert.equal(canStreamPreview("html", `${page}<link rel="stylesheet" href="https://x.test/a.css">`), false);
  assert.equal(canStreamPreview("html", `${page}<style>@import url(https://x.test/a.css);</style>`), false);
});

test("the shell runs only its own scripts and loads nothing", () => {
  const shell = buildStreamShell("html");
  const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(shell)[1].replaceAll("&#39;", "'");
  const nonce = /script-src 'nonce-([0-9a-f]{32})'/.exec(policy)[1];
  assert.match(policy, /default-src 'none'/);
  assert.doesNotMatch(policy.match(/script-src [^;]+/)[0], /unsafe-inline|unsafe-eval|https?:/);
  for (const directive of ["connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) {
    assert.ok(policy.includes(directive), directive);
  }
  assert.doesNotMatch(policy, /img-src[^;]*https?:/);
  // Every script of the shell carries the nonce; none is without one.
  const scripts = shell.match(/<script\b[^>]*>/g);
  assert.ok(scripts.length >= 2);
  for (const tag of scripts) assert.ok(tag.includes(`nonce="${nonce}"`), tag);
  assert.equal(buildStreamShell("html").includes(nonce), false, "a new shell gets a new nonce");
});

test("the shell takes the page by message from its parent and strips what could act", () => {
  const shell = buildStreamShell("html");
  assert.ok(shell.includes(JSON.stringify(HTML_PREVIEW_STREAM_MESSAGE)));
  assert.match(shell, /e\.source!==parent/);
  assert.match(shell, /new DOMParser\(\)\.parseFromString/);
  for (const tag of ["script", "iframe", "object", "embed", "link", "base", "meta"]) {
    assert.match(shell, new RegExp(`${tag}:1`), tag);
  }
  assert.match(shell, /indexOf\("on"\)===0/);
  assert.match(shell, /javascript\|vbscript/);
  assert.match(shell, /addEventListener\("click"/);
  assert.match(shell, /addEventListener\("submit"/);
  // The same frame rules as every preview.
  assert.doesNotMatch(HTML_PREVIEW_SANDBOX, /allow-same-origin/);
});

test("the shell carries the kit without forcing a colour scheme, and the label as text", () => {
  const shell = buildStreamShell("html", { theme: { scheme: "dark", background: "#111", text: "#eee" } }, 'Generating "x" <b>');
  assert.match(shell, /<style id="pi-theme-kit">:root\{--color-text-primary/);
  assert.doesNotMatch(shell, /color-scheme:dark/);
  assert.match(shell, /data-label="Generating &#34;x&#34; &#60;b&#62;"/);
  assert.match(shell, /<html data-scheme="dark">/);
  assert.match(buildStreamShell("svg"), /<html data-scheme="light" class="pi-svg">/);
  // A page that follows the theme tells the browser its scheme, and follows the app's theme changes.
  assert.match(shell, /html\.style\.colorScheme=html\.classList\.contains\("pi-themed"\)\?scheme:""/);
  assert.match(shell, /d\.type!==THEME/);
});
