// The blank-render check of finished previews, in real browsers: Chromium, and
// WebKit, the engine of the macOS desktop app. Each skips where Playwright or
// that browser is not installed.
import assert from "node:assert/strict";
import test from "node:test";
import { HTML_PREVIEW_ERROR_MESSAGE, HTML_PREVIEW_SANDBOX, buildHtmlPreviewDocument } from "./html-preview.ts";

let playwright = null;
try {
  playwright = await import("playwright");
} catch {
  // No Playwright: the test below skips.
}

async function launch(engine) {
  if (!playwright) return null;
  try {
    return await playwright[engine].launch();
  } catch {
    return null;
  }
}

const attr = (text) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

const cases = {
  emptyBody: ["html", "<!doctype html><html><head><style>body{margin:0}</style></head><body></body></html>", true],
  threwBeforeDrawing: ["html", "<!doctype html><html><body><div id=app></div><script>missing();document.getElementById('app').textContent='hi'</script></body></html>", true],
  offscreenOnly: ["html", "<!doctype html><html><body><div style='display:none'>hidden</div></body></html>", true],
  emptySvg: ["svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100%"><defs></defs></svg>', true],
  text: ["html", "<!doctype html><html><body><h1>Report</h1></body></html>", false],
  canvas: ["html", "<!doctype html><html><body style='margin:0'><canvas width=200 height=100 style='position:fixed;inset:0'></canvas></body></html>", false],
  paintedBox: ["html", "<!doctype html><html><body><div style='width:80px;height:40px;background:#3b82f6'></div></body></html>", false],
  svgShape: ["svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100%"><rect x="10" y="10" width="40" height="20"/></svg>', false],
  webComponent: ["html", "<!doctype html><html><body><x-card style='display:block;width:200px;height:60px'></x-card><script>customElements.define('x-card',class extends HTMLElement{connectedCallback(){this.attachShadow({mode:'open'}).innerHTML='<p>inside a shadow root</p>'}})</script></body></html>", false],
  drawnLate: ["html", "<!doctype html><html><body><script>setTimeout(function(){document.body.innerHTML='<p>late</p>'},800)</script></body></html>", false],
};

for (const engine of ["chromium", "webkit"]) test(`reports a finished page that shows nothing, and only such pages (${engine})`, async (t) => {
  const browser = await launch(engine);
  if (!browser) return t.skip(`no ${engine}`);
  try {
    const tab = await browser.newPage();
    const frames = Object.entries(cases).map(([name, [kind, code]]) =>
      `<iframe data-name="${name}" sandbox="${HTML_PREVIEW_SANDBOX}" style="width:320px;height:160px" srcdoc="${attr(buildHtmlPreviewDocument(kind, code))}"></iframe>`).join("");
    // A frame in a hidden container measures 0×0: it must wait, not report.
    const hidden = `<div id="hidden" style="display:none"><iframe data-name="hiddenText" sandbox="${HTML_PREVIEW_SANDBOX}" srcdoc="${attr(buildHtmlPreviewDocument("html", "<!doctype html><p>visible once shown</p>"))}"></iframe></div>`;
    await tab.setContent(`<!doctype html><body>${frames}${hidden}<script>
      window.reports={};addEventListener("message",e=>{const f=[...document.querySelectorAll("iframe")].find(x=>x.contentWindow===e.source);if(!f||!e.data||e.data.type!==${JSON.stringify(HTML_PREVIEW_ERROR_MESSAGE)})return;(window.reports[f.dataset.name]??=[]).push(e.data.message)});
    </script></body>`);
    await tab.waitForTimeout(6500);
    const reports = await tab.evaluate(() => window.reports);
    const blank = (name) => (reports[name] ?? []).some((message) => /rendered nothing visible/.test(message));
    for (const [name, [, , expected]] of Object.entries(cases)) {
      assert.equal(blank(name), expected, `${name}: ${JSON.stringify(reports[name] ?? [])}`);
    }
    assert.equal(blank("hiddenText"), false, "a frame without a size waits instead of reporting");
    // The page that threw reports its error as well as the blank render.
    assert.ok(reports.threwBeforeDrawing.some((message) => /missing/.test(message)));
  } finally {
    await browser.close();
  }
});
