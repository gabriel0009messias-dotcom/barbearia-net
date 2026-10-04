const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

test('webhook real: autenticacao, repeticao, QR, open/close e ausencia de loop/429', async t => {
  const environment = require('./helpers/postgres').testEnvironment();
  process.env.EVOLUTION_WEBHOOK_SECRET = 'synthetic-webhook-secret';
  process.env.EVOLUTION_API_URL = 'https://webhook-connection.test';
  process.env.EVOLUTION_API_KEY = 'synthetic-key';
  const db = require('../database'); await db.ready;
  const api = require('../evolutionApi');
  const app = express(); app.use(express.json()); app.use('/api', require('../routes'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  process.env.PUBLIC_APP_URL = `http://127.0.0.1:${server.address().port}`;
  const nativeFetch = global.fetch;
  let upstream = 0;
  t.mock.method(global, 'fetch', async () => { upstream++; throw Error('webhook must not call Evolution'); });
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await db.close(); await environment.cleanup(); });
  await db.runAsync("INSERT INTO assinaturas (id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session,status) VALUES (6,'Studio Teste','Teste','11999999999','mercado_pago',5,'','barbearia-6','ativo')");
  const post = async (payload, secret = 'synthetic-webhook-secret') => {
    const res = await nativeFetch(`http://127.0.0.1:${server.address().port}/api/webhook/evolution`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret }, body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  };
  const event = (state, instance = 'barbearia-6') => ({ event: 'connection.update', instance, data: { state } });
  assert.equal((await post(event('open'), 'wrong')).status, 401);
  assert.equal((await post(event('open', 'barbearia-1'))).body.ignored, true);
  const qr = { event: 'qrcode.updated', instance: 'barbearia-6', data: { qrcode: { base64: 'data:image/png;base64,c3ludGhldGlj' } } };
  const repeated = await Promise.all([post(qr), post(qr)]);
  assert.ok(repeated.every(r => r.status === 200));
  assert.equal(repeated.filter(r => r.body.duplicate).length, 1);
  assert.equal(api.obterCodigoConexao('barbearia-6').base64, qr.data.qrcode.base64);
  await post(event('open'));
  assert.equal((await api.obterEstadoConexao('barbearia-6', { cacheMs: 10000 })).instance.state, 'open');
  assert.equal(api.obterCodigoConexao('barbearia-6'), null);
  assert.equal((await db.getAsync('SELECT whatsapp_status FROM assinaturas WHERE id=6')).whatsapp_status, 'conectado');
  await post(event('close')); await post(event('open')); await post(event('close'));
  assert.equal((await api.obterEstadoConexao('barbearia-6', { cacheMs: 10000 })).instance.state, 'close', 'close depois de open e uma transicao legitima');
  assert.equal((await db.getAsync('SELECT whatsapp_status FROM assinaturas WHERE id=6')).whatsapp_status, 'desconectado');
  for (let i = 0; i < 140; i++) {
    const result = await post(event('close'));
    assert.equal(result.status, 200); assert.equal(result.body.duplicate, true);
  }
  const message = { event: 'messages.upsert', instance: 'barbearia-6', data: {
    key: { id: 'synthetic-message-1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
    message: { conversation: 'oi' },
  } };
  assert.equal((await post(message)).status, 200);
  assert.equal((await post(message)).body.duplicate, true);
  const rows = await db.allAsync('SELECT status FROM whatsapp_messages WHERE message_id=$1', ['synthetic-message-1']);
  assert.deepEqual(rows, [{ status: 'pending' }], 'HTTP confirma fila persistida antes de tentar entrega');
  assert.equal(upstream, 0);
});
