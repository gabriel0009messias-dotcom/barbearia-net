const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { assertFrontend } = require('./helpers/frontend');

test('servidor alternativo serve o frontend real e preserva rotas da API', async t => {
  const server = createApp().listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await assertFrontend(base);
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { status: 'ok' });
  assert.equal((await fetch(`${base}/api/auth/me`)).status, 401);
  const missing = await fetch(`${base}/api/rota-inexistente`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);
});
