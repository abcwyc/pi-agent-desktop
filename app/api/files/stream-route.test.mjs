import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");
const start = source.indexOf("function streamFile");
const end = source.indexOf("function escapeHtml", start);
assert.notEqual(start, -1, "streamFile not found");
assert.notEqual(end, -1, "streamFile end not found");
const streamBlock = source.slice(start, end);

test("streamed responses are not content-type sniffable", () => {
  assert.match(streamBlock, /"X-Content-Type-Options": "nosniff"/);
});

test("inline SVG is served with a script-blocking content security policy", () => {
  // SVG is the only inline preview type a browser executes as a document, so
  // it must never be able to run script in the Pi Web origin.
  assert.match(streamBlock, /contentType === "image\/svg\+xml"/);
  assert.match(streamBlock, /Content-Security-Policy/);
  assert.match(streamBlock, /default-src 'none'/);
});

test("local HTML previews are served as documents with a script-blocking CSP", () => {
  // The static HTML preview loads the file from this route so its relative
  // CSS/images resolve. A merge once dropped SERVE_EXT_TO_MIME from
  // getServeMime and every .html came back as application/octet-stream.
  const serveMime = source.slice(source.indexOf("function getServeMime"), source.indexOf("function streamFile"));
  assert.match(serveMime, /\|\| SERVE_EXT_TO_MIME\[getFileExt\(filePath\)\]/);
  assert.match(source, /html: "text\/html; charset=utf-8"/);
  assert.match(source, /css: "text\/css; charset=utf-8"/);
  const csp = source.slice(source.indexOf("const HTML_PREVIEW_CSP"), source.indexOf('].join("; ");'));
  for (const directive of ["script-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-ancestors 'self'"]) {
    assert.ok(csp.includes(`"${directive}"`), `HTML preview CSP must keep ${directive}`);
  }
  const serveBranch = source.slice(source.indexOf('if (type === "serve")'), source.indexOf('if (type === "meta")'));
  assert.match(serveBranch, /"Content-Security-Policy": HTML_PREVIEW_CSP/);
});

test("no file preview iframe combines scripts with the app origin", async () => {
  // allow-scripts + allow-same-origin would let a previewed file's JS call the
  // Pi Web API (and run commands through the agent). Served-from-disk previews
  // stay script-less; the opt-in scripted preview is an opaque-origin srcDoc.
  const viewer = await readFile(new URL("../../../components/FileViewer.tsx", import.meta.url), "utf8");
  const sandboxes = [...viewer.matchAll(/sandbox=(\{[^}]*\}|"[^"]*")/g)].map((match) => match[1]);
  assert.ok(sandboxes.length >= 2);
  for (const sandbox of sandboxes) {
    assert.ok(!(sandbox.includes("allow-scripts") && sandbox.includes("allow-same-origin")), `unsafe sandbox: ${sandbox}`);
  }
  const htmlPreview = viewer.slice(viewer.indexOf('isHtml && effectiveDisplayMode === "preview" ? ('), viewer.indexOf('isMarkdown && effectiveDisplayMode === "preview" ? ('));
  assert.match(htmlPreview, /srcDoc=\{content\}\s+sandbox="allow-scripts"/);
  assert.match(htmlPreview, /src=\{htmlPreviewUrl\}\s+sandbox="allow-same-origin"/);
});
