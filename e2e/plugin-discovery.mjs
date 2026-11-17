import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
const dir = 'test-results/plugin-discovery';
await mkdir(dir, { recursive: true });
await build({ entryPoints: ['e2e/plugin-discovery.fixture.jsx'], bundle: true, platform: 'browser', format: 'iife', outfile: `${dir}/fixture.js`, define: { 'process.env': '{"NODE_ENV":"production"}' }, jsx: 'automatic', logLevel: 'warning' });
const js = await readFile(`${dir}/fixture.js`);
const css = (await Promise.all(['app/globals.css', 'app/settings.css', 'app/native-theme.css'].map(p => readFile(p, 'utf8')))).map(s => s.replace(/^@import[^;]*;/gm, '')).join('\n');
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : req.url === '/style.css' ? 'text/css' : 'text/html');
  res.end(req.url === '/fixture.js' ? js : req.url === '/style.css' ? css : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/fixture.js"></script>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL, headless: true });
try {
  for (const theme of ['light', 'dark']) for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('pi-locale', 'en'));
    const installed = [];
    let failInstall = true;
    let trusted = true;
    const overview = () => ({ packages: installed, standaloneExtensions: [], diagnostics: [], totals: { extensions: 0, skills: 0, prompts: 0, themes: 0 }, projectResourcesLoaded: trusted });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/plugins/search') {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const query = url.searchParams.get('q');
        const names = query === 'empty' ? [] : offset ? ['openwiki'] : ['pi-web-access', '@postman/postman-plugin'];
        return route.fulfill({ json: { packages: names.map(name => ({ name, version: '1.0', publisher: 'fixture', description: 'Community package description.', url: `https://www.npmjs.com/package/${name}` })), nextOffset: query === 'empty' || offset ? null : 2 } });
      }
      if (url.pathname === '/api/plugins' && route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        assert.equal(body.action, 'install'); assert.equal(body.source, 'npm:pi-web-access'); assert.equal(body.cwd, '/fixture');
        if (failInstall) { failInstall = false; return route.fulfill({ status: 500, json: { error: 'Registry install failed; retry' } }); }
        installed.push({ source: body.source, scope: body.scope, status: 'loaded', counts: { extensions: 1, skills: 0, prompts: 0, themes: 0 }, resources: [] });
      }
      return route.fulfill({ json: overview() });
    });
    await page.goto(base);
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    // The catalog is the default desktop detail; phones open it from the list.
    await page.getByRole('button', { name: 'Plugin marketplace', exact: true }).click();
    await page.locator('.plugin-discovery-card').first().waitFor();
    assert.equal(await page.locator('.plugin-discovery-card').count(), 2);
    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.plugin-discovery-card').length === 3);
    await page.locator('.plugin-discovery-card').filter({ has: page.getByRole('heading', { name: 'pi-web-access', exact: true }) }).getByRole('button', { name: 'Install', exact: true }).click();
    await page.getByText('Registry install failed; retry', { exact: true }).waitFor();
    await page.locator('.plugin-discovery-card').filter({ has: page.getByRole('heading', { name: 'pi-web-access', exact: true }) }).getByRole('button', { name: 'Install', exact: true }).click();
    await page.getByRole('button', { name: 'installed', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Reload session', exact: true }).waitFor();
    assert.equal(installed.length, 1);
    await page.getByRole('button', { name: 'Project', exact: true }).click();
    const firstCard = page.locator('.plugin-discovery-card').filter({ has: page.getByRole('heading', { name: 'pi-web-access', exact: true }) });
    await firstCard.getByRole('button', { name: 'Install', exact: true }).click();
    await firstCard.getByRole('button', { name: 'installed', exact: true }).waitFor();
    assert.equal(installed.length, 2);
    assert.equal(installed[1].scope, 'project');
    await page.getByRole('button', { name: 'Global', exact: true }).click();
    await page.screenshot({ path: `${dir}/${theme}-${width}.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('textbox', { name: 'Search plugins…', exact: true }).fill('empty');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByText('No matching packages.', { exact: true }).waitFor();
    // Navigating away and back must retain the search, including on the phone's detail stack.
    if (width < 640) await page.getByRole('button', { name: 'Back to Plugins', exact: true }).click();
    await page.getByRole('button', { name: 'Add plugin', exact: true }).click();
    if (width < 640) await page.getByRole('button', { name: 'Back to Plugins', exact: true }).click();
    await page.getByRole('button', { name: 'Plugin marketplace', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Search plugins…', exact: true }).inputValue(), 'empty');
    await page.getByText('No matching packages.', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Search plugins…', exact: true }).fill('browser');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.locator('.plugin-discovery-card').first().waitFor();
    await page.getByRole('button', { name: 'Project', exact: true }).click();
    trusted = false;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Project' && b.disabled));
    assert.equal(await page.getByRole('button', { name: 'Project', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Project', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.plugin-discovery-card').nth(1).getByRole('button', { name: 'Install', exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Plugin discovery: desktop/mobile, light/dark, pagination, install and empty search passed.');
} finally { await browser.close(); await new Promise(r => server.close(r)); }
