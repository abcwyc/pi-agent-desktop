import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { chromium } from "playwright";
import { getPromptAnchorSpacerHeight } from "../lib/chat-lazy-load.ts";

// Exercise the actual hook callbacks against browser scroll geometry, without
// loading user sessions or invoking a model.
const source = ts.createSourceFile("useAgentSession.ts", await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function callback(name) {
  let result;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      result = ts.transpileModule(`(${node.initializer.arguments[0].getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(result, name);
  return result;
}
const callbacks = { anchor: callback("scrollUserMsgToTop"), tail: callback("scrollToBottom") };
const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined, headless: true });
try {
  for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 760 } });
    await page.setContent(`<style>
      * { box-sizing: border-box } body { margin: 0 }
      header { height: 48px; background: #222 }
      #scroll { height: 600px; overflow-y: scroll; overflow-anchor: none }
      #history { height: 600px } #user { height: 64px }
    </style><header>Title bar</header><div id="scroll"><div id="history"></div><div id="user">Sent message</div><div id="reply"></div><div id="anchor"></div><div id="composer"></div></div>`);
    await page.evaluate(({ callbacks, calculate }) => {
      const container = document.querySelector("#scroll");
      const el = document.querySelector("#user");
      const context = {
        scrollContainerRef: { current: container }, lastUserMsgRef: { current: el },
        liveFollowFrameRef: { current: null }, isNearBottomRef: { current: true }, previousScrollTopRef: { current: 0 },
      };
      const load = code => new Function(...Object.keys(context), `return ${code}`)(...Object.values(context));
      const anchor = load(callbacks.anchor), tail = load(callbacks.tail), spacerHeight = load(`(${calculate})`);
      for (const inset of [90, 148, 220]) {
        document.querySelector("#composer").style.height = `${inset}px`;
        for (const replyHeight of [0, 40, 100, 200]) {
          document.querySelector("#reply").style.height = `${replyHeight}px`;
          const contentEnd = document.querySelector("#anchor").getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
          document.querySelector("#anchor").style.height = `${spacerHeight(584, contentEnd, container.clientHeight, inset)}px`;
          anchor();
          tail("instant");
          const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
          if (Math.abs(top - 16) > 1) throw new Error(`Sent message hidden: inset=${inset}, reply=${replyHeight}, top=${top}`);
        }
      }
    }, { callbacks, calculate: getPromptAnchorSpacerHeight.toString() });
    console.log(`${width}px: sent message stays 16px below title bar during initial streaming and composer resizing`);
    await page.close();
  }
} finally {
  await browser.close();
}
