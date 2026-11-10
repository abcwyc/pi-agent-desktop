import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { normalizeDisplayMath, markdownPreviewRemarkPlugins, markdownPreviewRehypePlugins } = await jiti.import("../lib/markdown.ts");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

test("sandbox download anchors survive sanitization as local paths, never remote protocols", () => {
  const html = renderMarkdown("[下载](sandbox:/home/me/project/report%20%E5%8C%97.csv)");
  assert.match(html, /href="\/home\/me\/project\/report%20/);
  for (const target of ["sandbox://evil.example/file.csv", "sandbox:relative.csv", "sandbox:/%2Fevil.example/file.csv", "sandbox:/\t/evil.example/file.csv", "sandbox:/%09/evil.example/file.csv", "javascript:alert(1)"]) {
    const bad = renderMarkdown(`[bad](${target})`);
    assert.doesNotMatch(bad, /href="(?:sandbox|javascript):/);
    assert.doesNotMatch(bad, /href="[^\"]*evil\.example/);
  }
});

function renderMarkdown(markdown, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MarkdownBody, {
        cwd: "/home/me/project",
        onOpenFile() {},
        ...props,
      }, markdown),
    ),
  );
}

test("renders CJK sentence emphasis without spaces after closing punctuation", () => {
  const sentence = "今天天气很好。";
  const markdown = `**${sentence}**我们去公园散步吧。`;
  for (const props of [{}, { keepLineBreaks: true }]) {
    const html = renderMarkdown(markdown, props);
    assert.ok(html.includes(`<strong>${sentence}</strong>我们`));
    assert.doesNotMatch(html, /\*\*/);
  }
  const preview = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: markdownPreviewRemarkPlugins,
    rehypePlugins: markdownPreviewRehypePlugins,
  }, markdown));
  assert.ok(preview.includes(`<strong>${sentence}</strong>我们`));
});

test("renders CJK brackets next to prose while preserving nested emphasis", () => {
  assert.match(renderMarkdown("这是**「重要」**内容。"), /这是<strong>「重要」<\/strong>内容。/);
  assert.match(renderMarkdown("これは**テスト。**テスト"), /これは<strong>テスト。<\/strong>テスト/);
  assert.match(renderMarkdown("**outer *inner* text**"), /<strong>outer <em>inner<\/em> text<\/strong>/);
});

test("keeps CJK emphasis markers literal in code and escaped text", () => {
  const literal = "**需要。**即使";
  for (const markdown of [`\`${literal}\``, `\`\`\`\n${literal}\n\`\`\``, "\\*\\*需要。\\*\\*即使"]) {
    const html = renderMarkdown(markdown);
    assert.doesNotMatch(html, /<strong>/);
    assert.ok(html.includes(literal));
  }
});

test("opens non-file markdown links in a safe new tab", () => {
  const html = renderMarkdown("[docs](https://example.com/docs)");

  assert.match(
    html,
    /<a (?=[^>]*href="https:\/\/example\.com\/docs")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>docs<\/a>/,
  );
  assert.doesNotMatch(html, /\snode=/);
});

test("does not swallow trailing CJK text into a GFM autolink", () => {
  const html = renderMarkdown(
    "看 https://github.com/abcwyc/pi-agent-desktop/issues/48，然后来解决一下",
  );

  assert.match(
    html,
    /<a [^>]*href="https:\/\/github\.com\/abcwyc\/pi-agent-desktop\/issues\/48"[^>]*>https:\/\/github\.com\/abcwyc\/pi-agent-desktop\/issues\/48<\/a>，然后来解决一下/,
  );
});

test("keeps local file markdown links in the app", () => {
  const relativeHtml = renderMarkdown("[file](components/MarkdownBody.tsx)");
  const fileUrlHtml = renderMarkdown("[report](file:///home/me/project/report.html)");

  assert.match(relativeHtml, /<a href="components\/MarkdownBody\.tsx">file<\/a>/);
  assert.doesNotMatch(relativeHtml, /target=|rel=|\snode=/);
  assert.match(fileUrlHtml, /<a href="file:\/\/\/home\/me\/project\/report\.html">report<\/a>/);
  assert.doesNotMatch(fileUrlHtml, /target=|rel=|\snode=/);
});

test("keeps file URLs inert without an in-app file handler", () => {
  const html = renderMarkdown("[report](file:///home/me/project/report.html)", { onOpenFile: undefined });

  assert.match(html, /<a href="" target="_blank" rel="noopener noreferrer">report<\/a>/);
});

test("keeps single-tilde CJK numeric ranges literal instead of striking them", () => {
  const html = renderMarkdown("5~7U 保证金 × 100~200倍杠杆");

  assert.doesNotMatch(html, /<del>/);
  assert.match(html, /5~7U/);
  assert.match(html, /100~200倍/);
});

test("still renders double-tilde strikethrough", () => {
  const html = renderMarkdown("~~gone~~");

  assert.match(html, /<del>gone<\/del>/);
});

test("renders backslash-escaped backticks inside inline code", () => {
  const html = renderMarkdown("`AudioManager\\`1.cs`");

  assert.match(html, /<code[^>]*>AudioManager`1\.cs<\/code>/);
  assert.doesNotMatch(html, /<\/code>1\.cs`/);
});

test("renders LaTeX parenthesis delimiters as inline math", () => {
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.match(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("keeps prices and bold headings intact across a paragraph line break", () => {
  const html = renderMarkdown("**3. Membership — $20/mo (+tax)**\nOne free hour monthly. Waives the $6 activation fee.\n→ https://example.com/pricing");

  assert.match(html, /<strong>3\. Membership — \$20\/mo \(\+tax\)<\/strong>/);
  assert.match(html, /One free hour monthly\. Waives the \$6 activation fee\./);
  assert.match(html, /href="https:\/\/example\.com\/pricing"/);
  assert.doesNotMatch(html, /class="katex|\*\*/);
});

test("keeps adjacent amounts, ranges and decimals as currency", () => {
  for (const prices of ["$15+$15", "$20–$30", "$1,200.50 or $900.00", "**$20** and *$6*", "US$20 / CA$30"]) {
    const html = renderMarkdown(prices);
    assert.doesNotMatch(html, /class="katex/, prices);
    assert.equal((html.match(/\$/g) ?? []).length, 2, prices);
  }
});

test("does not let a price consume later math in the same paragraph", () => {
  const html = renderMarkdown("Pay $20 for the $x + 1$ option, or $30 for $2x + 3$.");

  assert.match(html, /Pay \$20 for the/);
  assert.match(html, /or \$30 for/);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 2);
  assert.match(html, /<annotation encoding="application\/x-tex">x \+ 1<\/annotation>/);
  assert.match(html, /<annotation encoding="application\/x-tex">2x \+ 3<\/annotation>/);
});

test("retains single-dollar equations, numeric math, balanced padding and multiline math", () => {
  for (const math of ["$x + y$", "$2 + 2 = 4$", "$20$", "$ x + y $", "$x $", "$ x$", "$x$2", "$x +\ny$", "$$x + y$$"]) {
    const html = renderMarkdown(math);
    assert.match(html, /class="katex"/, math);
    assert.doesNotMatch(html, /katex-error/, math);
  }
});

test("file previews and minimap Markdown use the same currency-safe math rules", () => {
  const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: markdownPreviewRemarkPlugins,
    rehypePlugins: markdownPreviewRehypePlugins,
  }, "**Price: $20/month**\nPlus a $6 fee. Formula: $2 + 2 = 4$."));
  assert.match(html, /<strong>Price: \$20\/month<\/strong>/);
  assert.match(html, /Plus a \$6 fee/);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
});

test("leaves escaped currency, code and link destinations intact", () => {
  const html = renderMarkdown("Prices: \\$20 and \\$6. Code: `$20 + $6`. [Price](https://example.com/$20/$6)");
  assert.doesNotMatch(html, /class="katex/);
  assert.match(html, /Prices: \$20 and \$6\./);
  assert.match(html, /<code[^>]*>\$20 \+ \$6<\/code>/);
  assert.match(html, /href="https:\/\/example\.com\/\$20\/\$6"/);
  const fenced = renderMarkdown("```text\n$20 + $6\n```");
  assert.doesNotMatch(fenced, /class="katex/);
});

test("currency text still passes through HTML and URL sanitization", () => {
  const html = renderMarkdown('$20 <img src="x" onerror="alert(1)"> $6 [click](javascript:alert(1))');
  assert.doesNotMatch(html, /onerror|javascript:|class="katex/);
  assert.match(html, /\$20/);
  assert.match(html, /\$6/);
});

test("renders paired LaTeX bracket delimiters as display math", () => {
  const html = renderMarkdown(String.raw`\[
P(\lambda)=o_b+\lambda r_b
\]`);
  const oneLineHtml = renderMarkdown(String.raw`\[P(\lambda)=o_b+\lambda r_b\]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /lambda/);
  assert.match(oneLineHtml, /class="katex-display"/);
});

test("renders model-emitted bracket-only formula lines as display math", () => {
  const html = renderMarkdown(String.raw`平均一致性：

[ C(x) = \frac{2}{T(T-1)} \sum_{i<j} S(\hat{y}^{(i)}, \hat{y}^{(j)}) ]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /\\sum/);
});

test("leaves an unmatched LaTeX bracket delimiter unchanged", () => {
  const markdown = String.raw`before
\[
x + y
after`;

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside Markdown code", () => {
  const markdown = "    \\(indented\\)\n\n`code\n\\(inline\\)`\n\n```text\n\\[\nfenced\n\\]\n```";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside raw HTML code", () => {
  const markdown = "<code>\\(inline\\)</code>\n\n<pre>\n\\(block\\)\n</pre>";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize escaped delimiters or link destinations", () => {
  const escaped = String.raw`Literal: \\(x+y\\).`;
  const link = String.raw`[docs](https://example.com/\(manual\))`;

  assert.equal(normalizeDisplayMath(escaped), escaped);
  assert.equal(normalizeDisplayMath(link), link);
});

test("previews completed Mermaid diagrams by default", () => {
  const html = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```");

  assert.match(html, /mermaid-block-loading/);
  assert.match(html, />Source</);
  assert.doesNotMatch(html, /A --&gt; B/);
});

test("keeps Mermaid source visible while the response is streaming", () => {
  const html = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```", { isStreaming: true });

  assert.doesNotMatch(html, /mermaid-block-loading/);
  assert.match(html, />Preview</);
  assert.match(html, /A --&gt; B/);
});

test("previews complete HTML documents in a sandboxed frame", () => {
  const html = renderMarkdown("```html\n<!DOCTYPE html>\n<html><body><h1>Hi</h1></body></html>\n```");

  assert.match(html, /<iframe[^>]*class="html-preview-frame[^"]*"/);
  assert.match(html, /sandbox="allow-scripts[^"]*"/);
  assert.doesNotMatch(html, /allow-same-origin/);
  assert.match(html, />Source</);
});

test("keeps HTML source visible while streaming and for fragments", () => {
  const streaming = renderMarkdown("```html\n<!DOCTYPE html>\n<html><body>x</body></html>\n```", { isStreaming: true });
  const fragment = renderMarkdown("```html\n<div>fragment</div>\n```");

  assert.doesNotMatch(streaming, /<iframe/);
  assert.match(streaming, />Preview</);
  assert.doesNotMatch(fragment, /<iframe/);
  assert.doesNotMatch(fragment, />Preview</);
});

test("renders artifact directives only when asked to", () => {
  const markdown = ':::artifact{identifier="calc" type="html" title="Calc"}\n```html\n<!DOCTYPE html>\n<html><body>x</body></html>\n```\n:::';
  const withArtifacts = renderMarkdown(markdown, { artifacts: true });
  const without = renderMarkdown(markdown);

  // No panel is registered in this render, so the artifact shows in place.
  assert.match(withArtifacts, /<iframe[^>]*class="html-preview-frame[^"]*"/);
  assert.doesNotMatch(withArtifacts, /:::artifact/);
  assert.match(without, /:::artifact/);
});

test("offers to run self-contained React fences, but shows source first", () => {
  const runnable = renderMarkdown("```jsx\nexport default function App() {\n  return <h1>Hi</h1>;\n}\n```");
  assert.doesNotMatch(runnable, /<iframe/);
  assert.match(runnable, /title="Run React component"/);

  const snippet = renderMarkdown("```jsx\nconst el = <h1>Hi</h1>;\n```");
  assert.doesNotMatch(snippet, /Run React component/);
});

test("does not auto-run scripted pages from history", () => {
  const html = renderMarkdown("```html\n<!DOCTYPE html>\n<html><body><script>for(;;){}</script></body></html>\n```");
  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, />Preview</);
});

test("opens markdown images in the shared image preview", () => {
  const localHtml = renderMarkdown("![chart](docs/tmp/chart.png)");
  const remoteHtml = renderMarkdown("![logo](https://example.com/logo.png)");

  assert.match(localHtml, /<button[^>]+aria-label="Preview image: chart"[^>]*>/);
  assert.match(localHtml, /<img[^>]+src="\/api\/files\/home\/me\/project\/docs\/tmp\/chart\.png\?type=read"/);
  assert.match(localHtml, /<img[^>]+alt="chart"/);
  assert.match(remoteHtml, /<button[^>]+aria-label="Preview image: logo"[^>]*>/);
  assert.match(remoteHtml, /<img[^>]+src="https:\/\/example\.com\/logo\.png"/);
});

test("keeps linked markdown images as links instead of nested preview buttons", () => {
  const html = renderMarkdown("[![diagram](docs/tmp/diagram.png)](https://example.com/docs)");

  assert.match(
    html,
    /<a (?=[^>]*href="https:\/\/example\.com\/docs")(?=[^>]*target="_blank")[^>]*>/,
  );
  assert.match(html, /<img[^>]+alt="diagram"/);
  assert.doesNotMatch(html, /<a[^>]*>[\s\S]*<button/);
  assert.doesNotMatch(html, /<button[^>]*>[\s\S]*<\/a>/);
});

test("uses a generic preview label when a markdown image has no alt text", () => {
  const html = renderMarkdown("![](https://example.com/shot.png)");

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.doesNotMatch(html, /Preview image:/);
});

test("a streaming body renders its text on the first paint", () => {
  const html = renderMarkdown("**Live** answer", { isStreaming: true });
  assert.match(html, /<strong>Live<\/strong> answer/);
});

// rehype-sanitize is the only thing between model/tool output and the DOM.
// Pinned end to end so a merge that drops the plugin or widens the schema fails.
test("strips executable HTML and javascript: links from rendered markdown", () => {
  const html = renderMarkdown([
    "<script>window.__pwned = 1</script>",
    "<img src=\"x\" onerror=\"window.__pwned = 1\">",
    "<iframe src=\"https://evil.example\"></iframe>",
    "<a href=\"javascript:alert(1)\">raw link</a>",
    "[md link](javascript:alert(1))",
    "<div onclick=\"alert(1)\" style=\"position:fixed\">styled</div>",
    "<form action=\"https://evil.example\"><input name=\"q\"></form>",
  ].join("\n\n"));
  assert.doesNotMatch(html, /<script|<iframe|<form|onerror|onclick|javascript:/i);
  assert.doesNotMatch(html, /position:fixed/);
  assert.match(html, /raw link/);
  assert.match(html, /md link/);
});

test("keeps CJK prose out of an autolinked URL", () => {
  const html = renderMarkdown("开 http://localhost:4321，或直接开 library/x.png。");

  assert.match(html, /<a (?=[^>]*href="http:\/\/localhost:4321")[^>]*>http:\/\/localhost:4321<\/a>/);
  assert.match(html, /<\/a>，或直接开 library\/x\.png。/);
  assert.doesNotMatch(html, /%EF%BC%8C/);
});

test("stops a bare autolink at trailing CJK punctuation", () => {
  const html = renderMarkdown("见 https://example.com/docs。");

  assert.match(html, /<a (?=[^>]*href="https:\/\/example\.com\/docs")[^>]*>https:\/\/example\.com\/docs<\/a>/);
  assert.match(html, /<\/a>。/);
});

test("leaves explicit markdown links, CJK paths and query strings intact", () => {
  const explicit = renderMarkdown("[文档](https://example.com/docs)，说明");
  assert.match(explicit, /<a (?=[^>]*href="https:\/\/example\.com\/docs")[^>]*>文档<\/a>/);
  assert.match(explicit, /<\/a>，说明/);

  const cjkPath = renderMarkdown("https://zh.wikipedia.org/wiki/中文条目");
  assert.match(cjkPath, /href="https:\/\/zh\.wikipedia\.org\/wiki\/%E4%B8%AD%E6%96%87%E6%9D%A1%E7%9B%AE"/);

  const query = renderMarkdown("https://a.com/p?a=1&b=2，后面");
  assert.match(query, /href="https:\/\/a\.com\/p\?a=1&amp;b=2"/);
  assert.match(query, /<\/a>，后面/);
});

test("turns line endings into <br> only when asked to keep line breaks", () => {
  assert.match(renderMarkdown("one\ntwo"), /<p>one\ntwo<\/p>/);
  assert.doesNotMatch(renderMarkdown("one\ntwo"), /<br/);

  for (const markdown of ["one\ntwo", "one\r\ntwo", "one\rtwo", "one   \t\n   two"]) {
    assert.match(renderMarkdown(markdown, { keepLineBreaks: true }), /<p>one<br\/>two<\/p>/);
  }
});

test("keeps typed line breaks in tight list items and headings", () => {
  const ordered = renderMarkdown("1. 看门狗的原理是（ ）\nA. 监控温度\nB. 计数器\n2. 下一题", { keepLineBreaks: true });
  const nested = renderMarkdown("- outer\n  more\n  - inner\n- next", { keepLineBreaks: true });
  const heading = renderMarkdown("Heading one\nheading two\n===", { keepLineBreaks: true });

  assert.match(ordered, /<li>看门狗的原理是（ ）<br\/>A\. 监控温度<br\/>B\. 计数器<\/li>/);
  assert.match(ordered, /<li>下一题<\/li>/);
  // The newline before a nested list separates blocks, so it must not become a <br>.
  assert.match(nested, /<li>outer<br\/>more\n<ul>\n<li>inner<\/li>/);
  assert.match(heading, /<h1>Heading one<br\/>heading two<\/h1>/);
  assert.doesNotMatch(renderMarkdown("- alpha\n\n- beta", { keepLineBreaks: true }), /<br/);
});

test("renders a hard break once when keeping line breaks", () => {
  // remark-rehype writes an mdast break as <br> plus "\n", which the user
  // bubble's pre-wrap paragraphs would show as a blank line.
  const html = renderMarkdown("trailing spaces  \nbackslash\\\nend", { keepLineBreaks: true });

  assert.match(html, /<p>trailing spaces<br\/>backslash<br\/>end<\/p>/);
});

test("leaves code and math line endings alone when keeping line breaks", () => {
  const code = renderMarkdown("```\nfirst\nsecond\n```", { keepLineBreaks: true });
  const math = renderMarkdown("$$\nx = 1\ny = 2\n$$", { keepLineBreaks: true });
  const emphasis = renderMarkdown("*one\ntwo* `a b`", { keepLineBreaks: true });

  assert.doesNotMatch(code, /<br/);
  assert.match(code, /first[\s\S]*\n[\s\S]*second/);
  assert.doesNotMatch(math, /<br/);
  assert.match(math, /<annotation encoding="application\/x-tex">x = 1\ny = 2<\/annotation>/);
  assert.match(emphasis, /<em>one<br\/>two<\/em>/);
});

test("a user message shows raw-text tags as typed and keeps its line breaks (#1407)", () => {
  // User messages print their HTML as the characters typed, as pi's TUI does, so a
  // pasted <textarea> or <script> neither swallows the rest of the block nor vanishes.
  assert.match(renderMarkdown("Use a <textarea> here\nand a button", { keepLineBreaks: true }), /<p>Use a &lt;textarea&gt; here<br\/>and a button<\/p>/);
  assert.match(renderMarkdown("add <script>a()\nb()</script> to the page", { keepLineBreaks: true }), /&lt;script&gt;a\(\)<br\/>b\(\)&lt;\/script&gt; to the page/);
  const list = renderMarkdown("- item <textarea>\n  more\n- two\n  lines", { keepLineBreaks: true });
  assert.match(list, /<li>two<br\/>lines<\/li>/);
});

test("shows a leading YAML block as a code fence instead of dropping it", () => {
  const html = renderMarkdown("---\ntitle: Demo\ntags: [a]\n---\n\nBody text");

  assert.match(html, /title/);
  assert.match(html, /Demo/);
  assert.match(html, /markdown-code-lang">yaml</);
  assert.match(html, /Body text/);
});

test("renders GitHub alerts as titled callouts", () => {
  const html = renderMarkdown("> [!WARNING]\n> Back up **first**.\n\nafter");

  assert.match(html, /<div class="markdown-alert markdown-alert-warning">/);
  assert.match(html, /<p class="markdown-alert-title">Warning<\/p>/);
  assert.match(html, /Back up <strong>first<\/strong>\./);
  assert.doesNotMatch(html, /\[!WARNING\]/);
});

test("a marker on its own line leaves no empty paragraph and unknown markers stay quotes", () => {
  const alert = renderMarkdown("> [!NOTE]\n>\n> Second paragraph");
  assert.match(alert, /markdown-alert-note/);
  assert.doesNotMatch(alert, /<p><\/p>/);

  const plain = renderMarkdown("> [!INFO]\n> text");
  assert.doesNotMatch(plain, /markdown-alert/);
  assert.match(plain, /<blockquote>/);
});

test("alert markers inside lists stay ordinary quotes", () => {
  const html = renderMarkdown("- item\n\n  > [!NOTE]\n  > nested");
  assert.doesNotMatch(html, /markdown-alert/);
});

test("an audio or video file a reply links as an image plays in place (C9)", () => {
  const audio = renderMarkdown("![take 2](media/take2.wav)");
  assert.match(audio, /<audio class="markdown-media" controls="" preload="metadata" src="\/api\/files\/[^"]*take2\.wav\?type=read" aria-label="take 2"><\/audio>/);
  assert.doesNotMatch(audio, /<img/);
  assert.match(renderMarkdown("![](clips/demo.mp4)"), /<video class="markdown-media" controls="" playsInline="" preload="metadata"|<video class="markdown-media" controls="" playsinline="" preload="metadata"/);
  // A remote clip keeps its URL; an image stays an image.
  assert.match(renderMarkdown("![](https://example.com/a.mp3?x=1)"), /<audio[^>]*src="https:\/\/example\.com\/a\.mp3\?x=1"/);
  assert.match(renderMarkdown("![chart](chart.png)"), /<img src="\/api\/files\/[^"]*chart\.png\?type=read" alt="chart"/);
});

test("a display formula carries a Copy button for its LaTeX (C8)", () => {
  const html = renderMarkdown("$$\nE = mc^2\n$$");
  assert.match(html, /<div class="markdown-math-display">[\s\S]*class="katex-display"[\s\S]*<button type="button" class="markdown-code-action markdown-math-copy">Copy<\/button><\/div>/);
  // Inline math has no button.
  assert.doesNotMatch(renderMarkdown("Energy is $E = mc^2$ here."), /markdown-math-copy/);
});

test("an extension message keeps its line breaks and indents, as pi's TUI prints it (C11)", () => {
  const html = renderMarkdown("Progress\n  ├─ step one\n  └─ step two", { keepTextLayout: true });
  assert.match(html, /Progress<br\/>/);
  assert.match(html, /├─ step one<br\/>/);
});
