const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../evolutionApi');

test('criacao Evolution: historico completo somente por configuracao explicita', async t => {
  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  process.env.EVOLUTION_API_URL = 'https://history-default.test';
  process.env.EVOLUTION_API_KEY = 'synthetic-history-test-key';
  delete process.env.EVOLUTION_ALWAYS_ONLINE;
  delete process.env.EVOLUTION_READ_MESSAGES;
  delete process.env.EVOLUTION_READ_STATUS;
  t.mock.method(console, 'info', () => {});
  const calls = [];
  const existing = { name: 'existing-history-fixture', connectionStatus: 'open', syncFullHistory: true };
  t.mock.method(global, 'fetch', async (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, 'https://history-default.test');
    calls.push({ path: target.pathname, query: target.search, method: options.method, body: options.body });
    if (target.pathname === '/instance/fetchInstances') {
      assert.equal(options.method, 'GET');
      assert.equal(target.searchParams.get('instanceName'), existing.name);
      return Response.json([existing]);
    }
    assert.equal(target.pathname, '/instance/create', 'nenhuma configuracao de instancia existente deve ser alterada');
    assert.equal(options.method, 'POST');
    return Response.json({ instance: { instanceName: JSON.parse(options.body).instanceName } });
  });

  for (const [value, expected] of [[undefined, false], ['true', true], ['false', false]]) {
    await t.test(`EVOLUTION_SYNC_FULL_HISTORY=${value ?? 'ausente'} envia ${expected}`, async () => {
      if (value === undefined) delete process.env.EVOLUTION_SYNC_FULL_HISTORY;
      else process.env.EVOLUTION_SYNC_FULL_HISTORY = value;
      const instanceName = `new-history-${value ?? 'default'}`;
      const before = calls.length;
      const result = await api.criarInstancia(instanceName);
      assert.deepEqual(result, { instance: { instanceName } });
      assert.equal(calls.length, before + 1);
      assert.deepEqual(JSON.parse(calls.at(-1).body), {
        instanceName, qrcode: false, integration: 'WHATSAPP-BAILEYS',
        alwaysOnline: true, readMessages: false, readStatus: false,
        syncFullHistory: expected, rejectCall: true, groupsIgnore: true,
      });
      assert.equal(await api.confirmarExistenciaInstancia(instanceName), true);
      assert.equal(calls.length, before + 1, 'criacao continua alimentando o cache de existencia');
    });
  }

  await t.test('consultar instancia existente nao aplica o novo default nem chama settings', async () => {
    delete process.env.EVOLUTION_SYNC_FULL_HISTORY;
    const before = calls.length;
    assert.deepEqual(await api.buscarInstancia(existing.name), existing);
    assert.deepEqual(calls.slice(before), [{
      path: '/instance/fetchInstances', query: '?instanceName=existing-history-fixture',
      method: 'GET', body: undefined,
    }]);
  });

  await t.test('criacao preserva DATABASE_SAVE_* e opcoes explicitas restantes', async () => {
    process.env.DATABASE_SAVE_DATA_HISTORIC = 'true';
    process.env.DATABASE_SAVE_DATA_NEW_MESSAGE = 'false';
    const saved = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('DATABASE_SAVE_')));
    const before = saved();
    process.env.EVOLUTION_ALWAYS_ONLINE = 'false';
    process.env.EVOLUTION_READ_MESSAGES = 'true';
    process.env.EVOLUTION_READ_STATUS = 'true';
    await api.criarInstancia('new-history-options', '5511999990000', { requestId: 'history-options-test' });
    assert.deepEqual(saved(), before);
    assert.deepEqual(JSON.parse(calls.at(-1).body), {
      instanceName: 'new-history-options', number: '5511999990000', qrcode: false,
      integration: 'WHATSAPP-BAILEYS', alwaysOnline: false, readMessages: true,
      readStatus: true, syncFullHistory: false, rejectCall: true, groupsIgnore: true,
    });
    assert.equal(calls.filter(call => call.method !== 'GET').every(call => call.path === '/instance/create'), true);
  });
});
