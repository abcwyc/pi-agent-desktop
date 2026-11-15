// The streaming shell in a real browser. Skipped where no Playwright browser is installed.
import assert from "node:assert/strict";
import test from "node:test";
import { buildStreamShell } from "./html-preview-stream.ts";
import { HTML_PREVIEW_SANDBOX } from "./html-preview.ts";

let playwright = null;
try {
  playwright = await import("playwright");
} catch {
  // No Playwright: the tests below skip.
}

async function launch() {
  if (!playwright) return null;
  try {
    return await playwright.chromium.launch();
  } catch {
    return null;
  }
}

const page = `<!doctype html><html><head><style>.card{padding:8px}</style><script>window.PWNED_HEAD=1;parent.postMessage({type:"evil"},"*")</script></head><body onload="window.PWNED_BODY=1"><h1>Report</h1><div class="card" id="c1">First</div><img src="x" onerror="window.PWNED_IMG=1"><a id="lnk" href="https://example.com/">link</a><a id="js" href="javascript:window.PWNED_JS=1">js</a><div class="card" id="c2">Second card</div><script>window.PWNED_SCRIPT=1</script></body></html>`;

test("draws a page as it grows without running it, and keeps what is already drawn", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no browser");
  try {
    const shell = buildStreamShell("html", {}, "Generating");
    const tab = await browser.newPage();
    await tab.setContent(`<!doctype html><body><iframe id="f" sandbox="${HTML_PREVIEW_SANDBOX}" srcdoc="${shell.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe><script>
      window.msgs=[];addEventListener("message",e=>window.msgs.push(e.data&&e.data.type));
      window.send=(html,themed)=>f.contentWindow.postMessage({type:"pi-html-preview:stream",html,themed:!!themed},"*");
    </script></body>`);
    await tab.waitForFunction(() => window.msgs.includes("pi-html-preview:ready"));
    const frame = tab.frames()[1];

    // A cut inside an attribute draws nothing for that tag; the next chunk completes it.
    const cuts = [page.indexOf("<h1>") + 12, page.indexOf('id="c1"') - 3, page.indexOf("<img"), page.length];
    let kept = false;
    for (const cut of cuts) {
      await tab.evaluate((html) => send(html, false), page.slice(0, cut));
      await tab.waitForTimeout(80);
      if (!kept) {
        kept = await frame.evaluate(() => { const h = document.querySelector("h1"); if (h) h.__kept = true; return !!h; });
      }
    }
    await tab.waitForTimeout(100);
    const state = await frame.evaluate(() => ({
      h1Kept: !!document.querySelector("h1")?.__kept,
      cards: document.querySelectorAll(".card").length,
      scripts: document.querySelectorAll("#root script").length,
      handlers: document.querySelectorAll("#root [onerror], [onload]").length,
      jsHref: document.getElementById("js")?.getAttribute("href") ?? null,
      pwned: ["PWNED_HEAD", "PWNED_BODY", "PWNED_IMG", "PWNED_SCRIPT", "PWNED_JS"].filter((key) => key in window),
      style: !!document.querySelector("#root style"),
    }));
    assert.equal(state.h1Kept, true, "elements already drawn are patched, not replaced");
    assert.equal(state.cards, 2);
    assert.equal(state.style, true, "head styles are kept");
    assert.equal(state.scripts, 0);
    assert.equal(state.handlers, 0);
    assert.equal(state.jsHref, null);
    assert.deepEqual(state.pwned, []);
    assert.equal(await tab.evaluate(() => window.msgs.filter((type) => type === "evil").length), 0);

    await frame.click("#lnk");
    await tab.waitForTimeout(100);
    assert.equal(await frame.evaluate(() => location.href), "about:srcdoc", "a link does not navigate the frame");
  } finally {
    await browser.close();
  }
});

test("the page text arrives only from the parent window", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no browser");
  try {
    const shell = buildStreamShell("html");
    const tab = await browser.newPage();
    await tab.setContent(`<!doctype html><body><iframe id="f" sandbox="${HTML_PREVIEW_SANDBOX}" srcdoc="${shell.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe><script>window.msgs=[];addEventListener("message",e=>window.msgs.push(e.data&&e.data.type))</script></body>`);
    await tab.waitForFunction(() => window.msgs.includes("pi-html-preview:ready"));
    const frame = tab.frames()[1];
    // The frame's own window posting to itself is not its parent.
    await frame.evaluate(() => postMessage({ type: "pi-html-preview:stream", html: "<p id=x>from self</p>" }, "*"));
    await tab.waitForTimeout(100);
    assert.equal(await frame.evaluate(() => !!document.getElementById("x")), false);
    await tab.evaluate(() => f.contentWindow.postMessage({ type: "pi-html-preview:stream", html: "<p id=y>from parent</p>" }, "*"));
    await tab.waitForTimeout(100);
    assert.equal(await frame.evaluate(() => !!document.getElementById("y")), true);
  } finally {
    await browser.close();
  }
});
