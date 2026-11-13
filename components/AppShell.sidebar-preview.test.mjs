import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const sidebarPeekTimerRef =");
const end = source.indexOf("  // The panel is a preview layer;", start);
assert.ok(start > 0 && end > start);
const code = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ESNext },
}).outputText;

function setup() {
  let id = 0;
  const timers = new Map();
  const effects = [];
  const context = createContext({
    isMobile: false, sidebarOpen: false, rightPanelFullWidth: false, settingsSection: null,
    peek: false, sidebarPeek: false, exiting: false, hovering: false,
    useRef: (current) => ({ current }), useCallback: (fn) => fn,
    useEffect: (fn) => effects.push(fn), useLayoutEffect() {},
    setTimeout: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
    clearTimeout: (key) => timers.delete(key),
  });
  context.setSidebarPeek = (value) => { context.peek = value; };
  context.setSidebarPeekExiting = (value) => { context.exiting = value; };
  context.sidebarResizer = { panelRef: { current: { matches: () => context.hovering } } };
  new Script(code).runInContext(context);
  const run = (text) => new Script(text).runInContext(context);
  const advance = () => {
    for (const [key, timer] of [...timers]) { timers.delete(key); timer.fn(); }
  };
  return { context, timers, run, advance, reset: effects[0], cleanup: effects[1]() };
}

test("hover preview does not change the desktop open preference and expires when never entered", () => {
  const s = setup();
  s.run("openSidebarPeek()");
  assert.equal(s.context.peek, true);
  assert.equal(s.context.sidebarOpen, false);
  assert.equal([...s.timers.values()][0].delay, 2600);
  s.advance();
  assert.equal(s.context.peek, false);
  assert.equal(s.context.exiting, true);
  s.advance();
  assert.equal(s.context.exiting, false);
});

test("entry cancels expiry; leave grace can be cancelled by reentry", () => {
  const s = setup();
  s.run("openSidebarPeek(); holdSidebarPeek()");
  assert.equal(s.timers.size, 0);
  s.run("closeSidebarPeekAfter(420)");
  assert.equal([...s.timers.values()][0].delay, 420);
  s.run("holdSidebarPeek()");
  s.advance();
  assert.equal(s.context.peek, true);
  s.run("closeSidebarPeekAfter(420)");
  s.advance();
  assert.equal(s.context.peek, false);
});

test("focus in sidebar or portal menus and pointer inside prevent expiry", () => {
  for (const held of ["sidebarPeekFocusRef.current = true", "hovering = true"]) {
    const s = setup();
    s.run("openSidebarPeek(); " + held);
    s.advance();
    assert.equal(s.context.peek, true);
  }
});

test("pinning, mobile, full-width panel and settings clear preview timers", () => {
  for (const key of ["sidebarOpen", "isMobile", "rightPanelFullWidth", "settingsSection"]) {
    const s = setup();
    s.run("openSidebarPeek()");
    s.context[key] = true;
    s.reset();
    assert.equal(s.context.peek, false);
    assert.equal(s.timers.size, 0);
  }
  for (const key of ["sidebarOpen", "isMobile", "rightPanelFullWidth"]) {
    const s = setup();
    s.context[key] = true;
    s.run("openSidebarPeek()");
    assert.equal(s.context.peek, false);
  }
});

test("unmount clears both the leave timer and exit reset", () => {
  for (const exiting of [false, true]) {
    const s = setup();
    s.run("openSidebarPeek()");
    if (exiting) s.advance();
    s.cleanup();
    assert.equal(s.timers.size, 0);
  }
});
