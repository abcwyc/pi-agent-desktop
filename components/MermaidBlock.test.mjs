import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { MermaidBlock, CodeBlock, downloadMermaidSvg, mermaidNaturalWidth, mermaidErrorText } = await jiti.import("./MermaidBlock.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

// Simple sequenceDiagram for testing
const mermaidSrc = `sequenceDiagram
    Alice->>Bob: Hello
    Bob-->>Alice: Hi`;

function renderMermaid(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MermaidBlock, props),
    ),
  );
}

test("MermaidBlock renders source by default", () => {
  const html = renderMermaid({ code: mermaidSrc });

  assert.match(html, />Preview</);
  assert.match(html, /Alice/);
  assert.doesNotMatch(html, /mermaid-block-loading/);
});

test("MermaidBlock can render preview by default", () => {
  const html = renderMermaid({ code: mermaidSrc, defaultPreview: true });

  assert.match(html, />Source</);
  assert.match(html, /mermaid-block-loading/);
  assert.doesNotMatch(html, /Alice/);
});

test("MermaidBlock with isStreaming falls back to source view", () => {
  const html = renderMermaid({ code: mermaidSrc, isStreaming: true, defaultPreview: true });

  assert.match(html, /disabled/);
  assert.match(html, />Preview</);
  assert.match(html, /Alice/);
  assert.match(html, /-&gt;&gt;/);
});

test("MermaidBlock renders empty graph without error", () => {
  const html = renderMermaid({ code: "graph TD", defaultPreview: true });

  assert.doesNotMatch(html, /mermaid-block-error/);
  assert.match(html, /mermaid-block-loading/);
});

function renderCode(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(CodeBlock, props),
    ),
  );
}

test("CodeBlock highlights code when not streaming", () => {
  const html = renderCode({ code: "const x = 1;", lang: "javascript" });

  assert.match(html, /class="token/);
  assert.match(html, /const/);
});

test("CodeBlock owns the pre background without a competing shorthand", () => {
  for (const isStreaming of [false, true]) {
    const html = renderCode({ code: "const x = 1;", lang: "javascript", isStreaming });
    const pre = html.match(/<pre\b[^>]*>/)?.[0];
    assert.ok(pre);
    assert.match(pre, /background-color:color-mix/);
    assert.doesNotMatch(pre, /(?:[;\"]|^)background:/);
  }
});

test("CodeBlock renders plain text without tokenization while streaming", () => {
  const html = renderCode({ code: "const x = 1;", lang: "javascript", isStreaming: true });

  assert.doesNotMatch(html, /class="token/);
  assert.match(html, /const x = 1;/);
});

test("CodeBlock hides line numbers for short snippets and keeps them for longer code", () => {
  assert.doesNotMatch(renderCode({ code: "npm test", lang: "bash" }), /linenumber/);
  assert.match(renderCode({ code: "a\nb\nc", lang: "bash" }), /linenumber/);
});

test("CodeBlock folds a long block behind an expand button once complete", () => {
  const code = Array.from({ length: 45 }, (_, i) => `line ${i}`).join("\n");

  const folded = renderCode({ code, lang: "text" });
  assert.match(folded, /markdown-code-body is-folded/);
  assert.match(folded, /aria-expanded="false"/);
  assert.match(folded, /Show all 45 lines/);

  const streaming = renderCode({ code, lang: "text", isStreaming: true });
  assert.doesNotMatch(streaming, /is-folded|markdown-code-fold/);

  const short = renderCode({ code: "a\nb", lang: "text" });
  assert.doesNotMatch(short, /markdown-code-fold/);
});

test("CodeBlock wraps long lines by default and offers to turn it off (C10)", () => {
  const html = renderCode({ code: "x", lang: "text" });
  assert.match(html, /aria-pressed="true"[^>]*>No wrap</);
  assert.match(html, /markdown-code-body[^"]* is-wrapped/);
});

test("MermaidBlock handles Chinese characters in diagram", () => {
  const chineseMermaid = `sequenceDiagram
    participant PC as PC客户端
    PC->>SV: 请求登录`;

  const html = renderMermaid({ code: chineseMermaid, defaultPreview: true });

  assert.doesNotMatch(html, /mermaid-block-error/);
  assert.match(html, /mermaid-block/);
});

test("downloadMermaidSvg downloads XML-serialized SVG and releases its URL", async () => {
  const originalDocument = globalThis.document;
  const originalXMLSerializer = globalThis.XMLSerializer;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const svgElement = { nodeName: "svg" };
  const serializedSvg = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">first<br />second</div></foreignObject></svg>';
  const link = { href: "", download: "", clicked: false, click() { this.clicked = true; } };
  let downloadedBlob;
  globalThis.document = { createElement: () => link };
  globalThis.XMLSerializer = class {
    serializeToString(element) {
      assert.equal(element, svgElement);
      return serializedSvg;
    }
  };
  URL.createObjectURL = (blob) => {
    assert.equal(blob.type, "image/svg+xml;charset=utf-8");
    downloadedBlob = blob;
    return "blob:mermaid";
  };
  let revoked = null;
  URL.revokeObjectURL = (url) => { revoked = url; };

  try {
    downloadMermaidSvg(svgElement);
    assert.equal(await downloadedBlob.text(), serializedSvg);
    assert.equal(link.href, "blob:mermaid");
    assert.equal(link.download, "mermaid-diagram.svg");
    assert.equal(link.clicked, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(revoked, "blob:mermaid");
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalXMLSerializer === undefined) delete globalThis.XMLSerializer;
    else globalThis.XMLSerializer = originalXMLSerializer;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

// Both dangerouslySetInnerHTML sinks render Mermaid's SVG output, and Mermaid's
// own strict mode is the only sanitizer on that path (it escapes HTML in labels
// and disables click callbacks). Pin it so a merge cannot loosen it silently.
test("mermaid renders in strict security mode", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./MermaidBlock.tsx", import.meta.url), "utf8");
  const inits = source.match(/mermaid\.initialize\(\{[\s\S]*?\}\);/g) ?? [];
  assert.ok(inits.length > 0, "mermaid.initialize call not found");
  for (const init of inits) assert.match(init, /securityLevel:\s*"strict"/);
  assert.doesNotMatch(source, /securityLevel:\s*"(loose|antiscript|sandbox)"/);
  assert.equal((source.match(/dangerouslySetInnerHTML/g) ?? []).length, 2, "a new HTML sink needs its own review");
});

test("reads a Mermaid diagram's natural width from its viewBox", () => {
  const svg = (viewBox) => `<svg id="m" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 616px;" viewBox="${viewBox}"><g/></svg>`;
  assert.equal(mermaidNaturalWidth(svg("0 0 616 305")), 616);
  assert.equal(mermaidNaturalWidth(svg("-8 -8 1689.875 205.5")), 1689.875);
  assert.equal(mermaidNaturalWidth(svg("0,0,320,200")), 320);
  assert.equal(mermaidNaturalWidth('<svg width="100%"><g/></svg>'), null);
  assert.equal(mermaidNaturalWidth(svg("0 0 0 0")), null);
  assert.equal(mermaidNaturalWidth("not an svg"), null);
});

test("fit mode stays off unless asked for", () => {
  const plain = renderMermaid({ code: mermaidSrc, defaultPreview: true });
  assert.doesNotMatch(plain, /mermaid-fit/);
});

test("keeps Mermaid's parse error for the block and the fix request", async () => {
  const parseError = new Error("Parse error on line 2:\r\n...A -->\r\n-----^\r\n\r\n\r\n\r\nExpecting 'SEMI', got 'EOF'");
  assert.equal(mermaidErrorText(parseError), "Parse error on line 2:\n...A -->\n-----^\n\nExpecting 'SEMI', got 'EOF'");
  assert.equal(mermaidErrorText("plain"), "plain");
  assert.equal(mermaidErrorText(null), "");
  const long = mermaidErrorText(new Error("x".repeat(5000)));
  assert.equal(long.length, 1001);
  assert.ok(long.endsWith("…"));
  // The error has to come from parse itself; suppressing it leaves only "invalid".
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./MermaidBlock.tsx", import.meta.url), "utf8");
  // Only the render path; the streaming warm-up parses a first word and ignores errors.
  const render = source.slice(source.indexOf("export async function renderMermaidSvg"), source.indexOf("const warmedTypes"));
  assert.match(render, /await mermaid\.parse\(code\);/);
  assert.doesNotMatch(render, /suppressErrors: true \}\)/);
});

test("offers no fix button before a diagram has failed", () => {
  const html = renderMermaid({ code: mermaidSrc, defaultPreview: true, fixable: true });
  assert.doesNotMatch(html, /mermaid-fix/);
});

test("a chunk that failed to load is not a syntax error", async () => {
  const { isLoadFailure } = await jiti.import("@/lib/chunk-load-error");
  // The message the dev server gave when it went away mid-render.
  assert.equal(isLoadFailure(new Error("Failed to load chunk /_next/static/chunks/node_modules_1rpy-c1dcp_8y._.js from module [project]/node_modules/mermaid/dist/chunks/mermaid.core/flowDiagram-HODETNUW.mjs [app-client] (ecmascript, async loader)")), true);
  assert.equal(isLoadFailure(Object.assign(new Error("x"), { name: "ChunkLoadError" })), true);
  assert.equal(isLoadFailure(new TypeError("Failed to fetch dynamically imported module: http://x/a.js")), true);
  assert.equal(isLoadFailure(new TypeError("Importing a module script failed.")), true);
  assert.equal(isLoadFailure(new Error("Parse error on line 3:\n...")), false);
  assert.equal(isLoadFailure("Failed to load chunk"), false);
  // Only a parse error offers the fix; a load failure offers Retry.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./MermaidBlock.tsx", import.meta.url), "utf8");
  assert.match(source, /failure !== null && !loadFailed && fixable && <DiagramFixButton/);
});
