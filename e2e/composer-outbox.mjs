import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createJiti } from 'jiti';
import { checkComposerGeometry } from './composer-geometry.mjs';

const dir = 'test-results/composer-outbox';
await mkdir(dir, { recursive: true });
await build({ entryPoints: ['e2e/composer-outbox.fixture.jsx'], bundle: true, platform: 'browser', format: 'iife', outfile: dir + '/fixture.js', define: { 'process.env': '{"NODE_ENV":"production"}' }, jsx: 'automatic', logLevel: 'warning' });
const css = (await Promise.all(['app/globals.css', 'app/settings.css', 'app/native-theme.css'].map(path => readFile(path, 'utf8')))).map(css => css.replace(/^@import[^;]*;/gm, '')).join('\n');
const js = await readFile(dir + '/fixture.js');
const { AgentSessionWrapper } = await createJiti(import.meta.url, { tsconfigPaths: true }).import('../lib/rpc-manager.ts');
let current;
function makeSession() {
  let active = true, complete;
  const listeners = new Set(), clients = new Set(), sent = [];
  const inner = {
    sessionId: randomUUID(), sessionFile: '', agent: { state: {} },
    get isStreaming() { return active; }, get isIdle() { return !active; },
    isBashRunning: false, isCompacting: false, extensionRunner: {},
    settingsManager: { getDefaultTools: () => [] }, sessionManager: { getCwd: () => '/fixture' },
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, dispose() {},
    emit(event) { listeners.forEach(fn => fn(event)); },
    finish() { inner.emit({ type: 'agent_end' }); active = false; inner.emit({ type: 'agent_settled' }); complete?.(); complete = undefined; },
    async abort() { inner.finish(); },
    async prompt(message, options) {
      sent.push({ message, behavior: options.streamingBehavior, images: options.images });
      options.preflightResult(active ? 'queued' : 'started');
      if (active) return;
      active = true; inner.emit({ type: 'agent_start' });
      return new Promise(resolve => { complete = resolve; });
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onEvent(() => clients.forEach(response => response.write('data: {}\n\n')));
  wrapper.start();
  return { wrapper, inner, clients, sent };
}
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://fixture').pathname;
    if (path === '/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.write('data: {}\n\n'); const owner = current; owner.clients.add(response); request.on('close', () => owner.clients.delete(response)); return;
    }
    if (path === '/state') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(await current.wrapper.send({ type: 'get_state' }))); return; }
    if (path === '/command') {
      let body = ''; for await (const chunk of request) body += chunk;
      const data = await current.wrapper.send(JSON.parse(body)); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data })); return;
    }
    if (path === '/finish') { current.inner.finish(); response.end('{}'); return; }
    response.setHeader('Content-Type', path === '/fixture.js' ? 'text/javascript' : path === '/style.css' ? 'text/css' : 'text/html');
    response.end(path === '/fixture.js' ? js : path === '/style.css' ? css : '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: String(error) })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
  for (const theme of ['light', 'dark']) for (const width of [1280, 390, 320]) {
    current = makeSession();
    const page = await browser.newPage({ viewport: { width, height: 760 }, hasTouch: width === 320, isMobile: width === 320, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('pi-locale', 'zh-CN'));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base); await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    const editor = page.locator('textarea'), main = page.locator('.composer-send-button');
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    await main.getAttribute('data-action').then(action => assert.equal(action, 'stop'));
    assert.equal(await page.locator('[data-action="stop"]').count(), 1);
    assert.equal(await page.locator('.composer-stop-button,.composer-queue-button').count(), 0);
    await checkComposerGeometry(page);
    await editor.fill('做完之后再检查一下测试');
    assert.equal(await main.getAttribute('data-action'), 'queue');
    await main.click();
    const rows = page.locator('.composer-outbox-row');
    await rows.waitFor(); assert.equal(await editor.inputValue(), '');
    assert.equal(await main.getAttribute('data-action'), 'stop');
    assert.equal(current.sent.length, 0);
    // Editing must merge into a draft already in progress.
    await editor.fill('已经在写的新草稿');
    await page.getByRole('button', { name: '编辑待发送消息', exact: true }).click();
    await rows.waitFor({ state: 'hidden' });
    assert.match(await editor.inputValue(), /做完之后再检查一下测试/); assert.match(await editor.inputValue(), /已经在写的新草稿/);
    await main.click(); await rows.waitFor();
    await editor.fill('这是第二条补充消息'); await main.click();
    await page.waitForFunction(() => document.querySelectorAll('.composer-outbox-row').length === 2);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.chat-composer')).backgroundColor === getComputedStyle(document.querySelector('.composer-outbox')).backgroundColor);
    // Persist server-owned pending entries over a page reload.
    await page.reload(); await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await page.waitForFunction(() => document.querySelectorAll('.composer-outbox-row').length === 2);
    const layout = await page.locator('.composer-outbox').evaluate(el => {
      const r = el.getBoundingClientRect(), card = el.nextElementSibling.getBoundingClientRect();
      return { left: r.left, right: r.right, bottom: r.bottom, cardTop: card.top, viewport: innerWidth };
    });
    assert.ok(layout.left >= 0 && layout.right <= layout.viewport, JSON.stringify(layout));
    assert.ok(layout.bottom - layout.cardTop >= 10 && layout.bottom - layout.cardTop <= 14, 'outbox must dock to the card');
    await page.screenshot({ path: `${dir}/${theme}-${width}.png` });
    await page.locator('.chat-input-shell').screenshot({ path: `${dir}/${theme}-${width}-composer.png` });
    await rows.last().getByRole('button', { name: '删除待发送消息', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.composer-outbox-row').length === 1);
    await page.getByRole('button', { name: '立即发送', exact: true }).click();
    await rows.waitFor({ state: 'hidden' });
    assert.equal(current.sent.length, 1); assert.equal(current.sent[0].behavior, 'steer');
    // Stop must leave pending messages in place, with no automatic restart.
    await editor.fill('停止后保留这条消息'); await main.click(); await rows.waitFor();
    await main.click(); await page.waitForFunction(() => document.querySelector('.composer-send-button').dataset.action === 'send');
    assert.equal(await rows.count(), 1); assert.equal(current.sent.length, 1);
    // Sending the preserved item while idle starts it rather than stranding it.
    await page.getByRole('button', { name: '立即发送', exact: true }).click(); await rows.waitFor({ state: 'hidden' });
    assert.equal(current.sent.length, 2);
    // An ordinary queued message starts once the running task settles.
    await editor.fill('自动继续处理'); await main.click(); await rows.waitFor();
    await page.evaluate(() => window.__fixture.finish()); await rows.waitFor({ state: 'hidden' });
    assert.equal(current.sent.length, 3); assert.equal(current.sent[2].behavior, 'followUp');
    // Reproduce the reported race: background delivery claims a row after the
    // user clicks it, but before that action reaches the server.
    for (const action of ['send', 'edit', 'delete']) {
      await editor.fill('竞态测试 ' + action); await main.click(); await rows.waitFor();
      const before = current.sent.length;
      const actionType = action === 'send' ? 'send_composer_message' : 'take_composer_message';
      await page.route(base + '/command', async route => {
        if (route.request().postDataJSON().type === actionType) {
          current.inner.finish();
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        await route.continue();
      });
      const response = page.waitForResponse(response => response.url() === base + '/command' && response.request().postDataJSON()?.type === actionType);
      const label = action === 'send' ? '立即发送' : action === 'edit' ? '编辑待发送消息' : '删除待发送消息';
      await rows.getByRole('button', { name: label, exact: true }).click();
      const result = await response;
      assert.equal(result.status(), 200);
      assert.equal((await result.json()).data.item, null);
      await rows.waitFor({ state: 'hidden' });
      assert.equal(current.sent.length, before + 1, 'stale click must not duplicate delivery');
      assert.equal(await editor.inputValue(), '', 'stale edit must not restore already-sent text');
      await page.unroute(base + '/command');
    }
    assert.deepEqual(errors, []);
    await page.close(); current.inner.finish(); current.wrapper.destroy();
    console.log(`${theme} ${width}: one action, queue/edit/delete/steer, reload, stop, automatic delivery, concentric geometry passed`);
  }
} finally {
  if (browser) await browser.close();
  current?.inner.finish(); current?.wrapper.destroy();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
