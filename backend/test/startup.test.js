const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('backend inicia sem credenciais de pagamento e serve painel e API', { timeout: 20000 }, async t => {
  const testDb = require('./helpers/postgres').testEnvironment();
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['app.js'], {
    cwd: path.join(__dirname, '..'), windowsHide: true,
    env: { ...process.env, PORT: String(port), MERCADO_PAGO_ACCESS_TOKEN: '', MERCADO_PAGO_WEBHOOK_SECRET: '', EVOLUTION_API_URL: '', EVOLUTION_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics='';
  child.stderr.on('data',data=>{diagnostics+=String(data);});
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    await testDb.cleanup();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend nao iniciou no prazo.')), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Backend encerrou: ${code}`)); });
    child.stdout.on('data', data => {
      if (String(data).includes('Servidor rodando na porta')) { clearTimeout(timer); resolve(); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  await require('./helpers/frontend').assertFrontend(base);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  const markers=['synthetic-password','synthetic-token','synthetic-authorization','synthetic-cookie'];
  const malformed=await fetch(base+'/api/publico/assinaturas',{method:'POST',headers:{'Content-Type':'application/json',Authorization:markers[2],Cookie:markers[3]},body:JSON.stringify({senha:markers[0],token:markers[1],Authorization:markers[2]})+','});
  assert.equal(malformed.status,400);
  assert.equal(malformed.headers.get('cache-control'),'no-store');
  const invalidBody=JSON.stringify(await malformed.json());
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(diagnostics.includes('invalid_json'));
  for(const marker of markers){assert.equal(diagnostics.includes(marker),false);assert.equal(invalidBody.includes(marker),false);}

  const config = await (await fetch(`${base}/api/publico/assinatura-config`)).json();
  assert.equal(config.gateway.provider, 'mercado_pago');
  assert.equal(config.gateway.enabled, false);
  assert.deepEqual(config.metodosPagamento, ['mercado_pago']);
  const page = await (await fetch(`${base}/cadastro.html`)).text();
  assert.match(page, /Mercado Pago/);
  for (const route of ['/criar-cliente', '/criar-assinatura', '/api/criar-cliente', '/api/criar-assinatura']) {
    assert.equal((await fetch(base + route, { method: 'POST' })).status, 404);
  }
});
