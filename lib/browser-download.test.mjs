import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { downloadUrlAsFile } = await jiti.import('./desktop-native.ts');

test('browser saves response bytes locally without sending client paths to desktop APIs', async (t) => {
  const calls = [], clicks = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    return new Response('server file', { headers: { 'content-type': 'text/plain' } });
  });
  t.mock.method(URL, 'createObjectURL', (blob) => {
    assert.equal(blob.size, 11);
    return 'blob:download';
  });
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const oldDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({ click() { clicks.push([this.href, this.download]); }, remove() {} }),
    body: { appendChild() {} },
  };
  try {
    await downloadUrlAsFile('/api/files/server/report.txt?type=download', 'report.txt');
    assert.deepEqual(calls, ['/api/files/server/report.txt?type=download']);
    assert.deepEqual(clicks, [['blob:download', 'report.txt']]);
  } finally { globalThis.document = oldDocument; }
});

test('browser download rejects authentication failures and oversized responses', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('denied', { status: 403 }));
  await assert.rejects(downloadUrlAsFile('/api/file', 'file'), /HTTP 403/);
  globalThis.fetch = async () => new Response('', { headers: { 'content-length': String(101 * 1024 * 1024) } });
  await assert.rejects(downloadUrlAsFile('/api/file', 'file'), /larger than/);
});
