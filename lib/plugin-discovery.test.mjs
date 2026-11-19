import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { pluginSearchParams, parsePluginSearch, searchPlugins } = await jiti.import('./plugin-discovery.ts');

test('search bounds reject invalid offsets and oversized input', () => {
  assert.deepEqual(pluginSearchParams(new URLSearchParams('q= browser &offset=20')), { query: 'browser', offset: 20 });
  for (const value of ['-1', 'NaN', '1.5', '10001']) assert.throws(() => pluginSearchParams(new URLSearchParams({ offset: value })));
  assert.throws(() => pluginSearchParams(new URLSearchParams({ q: 'x'.repeat(161) })));
});

test('registry rows require an ecosystem keyword and valid npm identity; pagination follows raw rows', () => {
  const result = parsePluginSearch({ total: 7, objects: [
    { package: { name: '@team/plugin', version: '1.0', keywords: ['pi-package'], publisher: { username: 'team', email: 'private' } } },
    { package: { name: 'unrelated', keywords: [] } },
    { package: { name: 'bad?name', keywords: ['pi-package'] } },
  ] }, 0);
  assert.equal(result.nextOffset, 3);
  assert.equal(result.packages.length, 1);
  assert.equal(result.packages[0].url, 'https://www.npmjs.com/package/@team/plugin');
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(parsePluginSearch({ total: 3, objects: [] }, 3).nextOffset, null);
  assert.throws(() => parsePluginSearch({ error: 'bad' }, 0));
});

test('search fixes upstream origin and keyword and reuses a short cache', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    assert.equal(url.origin, 'https://registry.npmjs.org');
    assert.equal(url.searchParams.get('text'), '"browser" "keywords" "other" keywords:pi-package');
    return Response.json({ total: 0, objects: [] });
  };
  try {
    await Promise.all([searchPlugins('browser keywords:other', 0), searchPlugins('browser keywords:other', 0)]);
    await searchPlugins('browser keywords:other', 0);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
