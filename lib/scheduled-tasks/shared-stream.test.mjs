import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { openSharedEventStream } = await createJiti(import.meta.url).import("./shared-stream.ts");

/** An in-memory stand-in for the browser's lock manager and BroadcastChannel, shared by "tabs". */
function makeBrowser() {
  const queue = [];
  let held = false;
  const channels = new Set();
  const sources = [];

  const grantNext = () => {
    if (held) return;
    const next = queue.shift();
    if (!next) return;
    held = true;
    Promise.resolve(next.callback()).finally(() => { held = false; grantNext(); });
  };

  return {
    sources,
    openSources: () => sources.filter((s) => !s.closed),
    tab(retryMs = 5) {
      return {
        locks: {
          request(name, { signal }, callback) {
            return new Promise((resolve, reject) => {
              const entry = { callback: () => callback().then(resolve) };
              signal?.addEventListener("abort", () => {
                const index = queue.indexOf(entry);
                if (index !== -1) { queue.splice(index, 1); reject(new DOMException("aborted", "AbortError")); }
              });
              queue.push(entry);
              grantNext();
            });
          },
        },
        createChannel() {
          const channel = {
            onmessage: null,
            postMessage(data) { for (const other of channels) if (other !== channel) other.onmessage?.({ data }); },
            close() { channels.delete(channel); },
          };
          channels.add(channel);
          return channel;
        },
        createSource(url) {
          const source = { url, readyState: 1, closed: false, onopen: null, onmessage: null, onerror: null, close() { this.closed = true; this.readyState = 2; } };
          sources.push(source);
          return source;
        },
        closedState: 2,
        retryMs,
      };
    },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const frame = (event) => ({ data: JSON.stringify(event) });

test("with several tabs only the leader opens the stream, and every tab hears its events", async () => {
  const browser = makeBrowser();
  const heard = [[], [], []];
  const stops = heard.map((into) => openSharedEventStream({
    url: "/events", name: "scheduled", onEvent: (event) => into.push(event), env: browser.tab(),
  }));
  await tick();
  assert.equal(browser.openSources().length, 1, "one connection for three tabs");

  browser.sources[0].onmessage(frame({ type: "run_finished", n: 1 }));
  assert.deepEqual(heard.map((events) => events.length), [1, 1, 1]);
  stops.forEach((stop) => stop());
});

test("when the leader closes, the next tab takes over and keeps receiving", async () => {
  const browser = makeBrowser();
  const heard = [[], []];
  const stopLeader = openSharedEventStream({ url: "/events", name: "s", onEvent: (e) => heard[0].push(e), env: browser.tab() });
  const stopFollower = openSharedEventStream({ url: "/events", name: "s", onEvent: (e) => heard[1].push(e), env: browser.tab() });
  await tick();
  assert.equal(browser.sources.length, 1);

  stopLeader();
  await tick();
  assert.equal(browser.sources[0].closed, true, "the old leader's stream is closed");
  assert.equal(browser.openSources().length, 1, "and exactly one new one is open");

  browser.openSources()[0].onmessage(frame({ n: 2 }));
  assert.deepEqual(heard[1], [{ n: 2 }]);
  stopFollower();
});

test("a tab that stops while still waiting never opens a stream", async () => {
  const browser = makeBrowser();
  const stopLeader = openSharedEventStream({ url: "/e", name: "s", onEvent: () => undefined, env: browser.tab() });
  const stopWaiting = openSharedEventStream({ url: "/e", name: "s", onEvent: () => undefined, env: browser.tab() });
  await tick();
  stopWaiting();
  stopLeader();
  await tick();
  assert.equal(browser.sources.length, 1, "the waiting tab was dropped from the queue");
});

test("the leader reports each (re)connection and survives a malformed frame", async () => {
  const browser = makeBrowser();
  let opened = 0;
  const heard = [];
  const stop = openSharedEventStream({ url: "/e", name: "s", onEvent: (e) => heard.push(e), onOpen: () => { opened += 1; }, env: browser.tab() });
  await tick();
  const [source] = browser.sources;
  source.onopen({});
  source.onmessage({ data: "{ not json" });
  source.onmessage(frame({ ok: true }));
  assert.equal(opened, 1);
  assert.deepEqual(heard, [{ ok: true }]);
  stop();
});

test("a stream the browser gave up on is reopened after a pause", async () => {
  const browser = makeBrowser();
  const stop = openSharedEventStream({ url: "/e", name: "s", onEvent: () => undefined, env: browser.tab(5) });
  await tick();
  const first = browser.sources[0];
  first.readyState = 2;
  first.onerror({});
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(browser.sources.length, 2);
  stop();
  assert.equal(browser.openSources().length, 0);
});

test("without Web Locks every tab opens its own stream", async () => {
  const browser = makeBrowser();
  const { locks, ...withoutLocks } = browser.tab();
  void locks;
  const a = openSharedEventStream({ url: "/e", name: "s", onEvent: () => undefined, env: withoutLocks });
  const b = openSharedEventStream({ url: "/e", name: "s", onEvent: () => undefined, env: browser.tab() && withoutLocks });
  assert.equal(browser.sources.length, 2);
  a(); b();
  assert.equal(browser.openSources().length, 0);
});
