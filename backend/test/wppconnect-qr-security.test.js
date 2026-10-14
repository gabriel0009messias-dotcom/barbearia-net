const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { logEvolutionError } = require('../evolutionApi');

test('standalone legacy bridge retains QR in memory without printing or returning pairing', async t => {
  const routes = new Map(), output = [], configs = [];
  let terminalCalls = 0, mode = 'ascii';
  const qr = 'data:image/png;base64,U1lOVEhFVElD', ascii = 'SYNTHETIC_ASCII_PAIRING';
  const app = { use() {}, get(name, handler) { routes.set('GET '+name, handler); }, post(name, handler) { routes.set('POST '+name, handler); }, listen(port, host) { assert.equal(host, '127.0.0.1'); } };
  const express = () => app; express.json = () => () => {};
  const logger = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(level => [level, (...args) => output.push(args.join(' '))]));
  for (const level of ['info', 'error']) t.mock.method(console, level, (...args) => output.push(args.join(' ')));
  const context = { require(name) {
    if (name === 'express') return express;
    if (name === './loadEnv') return {};
    if (name === './evolutionApi') return { logEvolutionError };
    if (name === 'qrcode-terminal') return { generate() { terminalCalls++; } };
    if (name === './botFlow') return { attachBotHandlers() {} };
    if (name === './whatsappBrowser') return { criarOpcoesWppconnect(options) { return { ...options, logQR: false }; } };
    if (name === '@wppconnect-team/wppconnect') return { async create(options) { configs.push(options); options.catchQR(qr, mode === 'ascii' ? ascii : null); if (mode === 'error') throw Error(ascii+qr); return {}; } };
    throw Error('Unexpected dependency');
  }, console: logger, process: { env: {} }, Buffer, URL, Map, Set, Number, Date, Promise };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../wppconnect.js'), 'utf8'), context, { filename: 'wppconnect.js', timeout: 1000 });
  async function invoke(method, id, body) { let status = 200, data; await routes.get(method)({ params: { assinaturaId: id }, body }, { json(value) { data = value; }, status(value) { status = value; return this; } }); return { status, data }; }
  for (const [index, variant] of ['ascii', 'image-only'].entries()) await t.test(`${variant} callback has no sensitive logger or terminal calls`, async () => {
    mode = variant; const id = String(806+index);
    context.binding = { apiBaseUrl: 'https://example.invalid', barberToken: 'synthetic-token' };
    await vm.runInNewContext(`iniciarSessao('${id}', binding)`, context);
    assert.equal(vm.runInNewContext(`obterSessao('${id}').qrCode`, context), qr);
    assert.equal(terminalCalls, 0); assert.ok(configs.every(options => options.logQR === false));
    for (const secret of [qr, ascii]) assert.ok(!output.join('\n').includes(secret));
  });
  await t.test('generic status never returns QR without authentication, for either tenant', async () => {
    for (const id of ['806', '807']) {
      const result = await invoke('GET /sessions/:assinaturaId/status', id);
      assert.equal(result.status, 403); assert.equal(result.data.qrCode, undefined);
      assert.ok(!JSON.stringify(result.data).includes(qr));
    }
  });
  await t.test('provider errors do not disclose pairing in start, status or logs', async () => {
    mode = 'error'; const result = await invoke('POST /sessions/:assinaturaId/start', '808', { apiBaseUrl: 'https://example.invalid', barberToken: 'synthetic-token' });
    assert.equal(result.status, 403);
    context.binding = { apiBaseUrl: 'https://example.invalid', barberToken: 'synthetic-token' };
    await assert.rejects(vm.runInNewContext(`iniciarSessao('808', binding)`, context));
    const status = await invoke('GET /sessions/:assinaturaId/status', '808');
    for (const secret of [qr, ascii]) assert.ok(!(JSON.stringify(result)+JSON.stringify(status)+output.join('\n')).includes(secret));
  });
});
